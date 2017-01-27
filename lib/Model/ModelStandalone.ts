import { EventEmitter } from 'events';
import uuid             from 'uuid';

import util             from '../util';

// collection
import { Collection,
         CollectionMap,
         ModelData }    from './collections';
import { Doc }          from './Doc';
import LocalDoc         from './LocalDoc';


require('./mutators');
require('./setDiff');

require('./fn');
require('./filter');
require('./refList');
require('./ref');


export interface Options {
  debug?: DebugOptions;
  bundleTimeout?: number;
}

export interface DebugOptions {
  remoteMutations?: boolean;
  disableSubmit?: boolean;
}

export default class Model extends EventEmitter {
  public static ChildModel = ChildModel;

  public static INITS = [];

  // events
  // These events are re-emitted as 'all' events, and they are queued up and
  // emitted in sequence, so that events generated by other events are not
  // seen in a different order by later listeners
  public static MUTATOR_EVENTS = {
    change: true,
    insert: true,
    remove: true,
    move: true,
    load: true,
    unload: true
  };

  root: Model;
  debug: DebugOptions;

  // events
  _mutatorEventQueue: [string, string[], any[]][];
  _pass: typeof Passed;
  _silent: boolean;
  _eventContext: any;       // seems like this can really be anything
  _defaultCallback: (err?) => void;

  // private EventEmitter properties
  _events;
  _maxListeners;

  // paths
  _at: string;  // this is a path

  // collections
  collections: CollectionMap;
  data: ModelData;




  // CTOR

  constructor(options: Options = {}) {
    super();
    this.root = this;

    const inits = Model.INITS;
    this.debug = options.debug || {};
    for (let i = 0; i < inits.length; i++) {
      inits[i](this, options);
    }
  }

  id() {
    return uuid.v4();
  }

  _child(): ChildModel {
    return new ChildModel(this);
  }


  ///////////////////////
  // events
  ///////////////////////

  wrapCallback(cb) {
    if (!cb) return this.root._defaultCallback;
    const model = this;
    return function wrappedCallback() {
      try {
        return cb.apply(this, arguments);
      } catch (err) {
        model._emitError(err);
      }
    };
  }

  _emitError(err, context?): void {
    let message = (err.message) ? err.message :
      (typeof err === 'string') ? err : 'Unknown model error';
    if (context) {
      message += ' ' + context;
    }
    if (err.data) {
      try {
        message += ' ' + JSON.stringify(err.data);
      } catch (stringifyErr) {}
    }
    if (err instanceof Error) {
      err.message = message;
    } else {
      err = new Error(message);
    }
    this.emit('error', err);
  }

  emit(type: string, ...args: any[]) {
    if (type === 'error') {
      return super.emit(type, args);
    }
    if (Model.MUTATOR_EVENTS[type]) {
      if (this._silent) return this;
      let segments = args[0];
      let eventArgs = args[1];
      super.emit(type + 'Immediate', segments, eventArgs);
      if (this.root._mutatorEventQueue) {
        this.root._mutatorEventQueue.push([type, segments, eventArgs]);
        return this;
      }
      this.root._mutatorEventQueue = [];
      super.emit(type, segments, eventArgs);
      super.emit('all', segments, [type].concat(eventArgs));
      while (this.root._mutatorEventQueue.length) {
        const queued = this.root._mutatorEventQueue.shift();
        type = queued[0];
        segments = queued[1];
        eventArgs = queued[2];
        super.emit(type, segments, eventArgs);
        super.emit('all', segments, [type].concat(eventArgs));
      }
      this.root._mutatorEventQueue = null;
      return this;
    }
    return super.emit.apply(this, arguments);
  }

  addListener(type: string | symbol, listener: Function): this; // EventEmitter;
  addListener(type: string | symbol, pattern, cb?): any {
    const listener = eventListener(this, pattern, cb);
    super.on(type, listener);
    return listener;
  }

  on(type: string | symbol, listener: Function): this; // EventEmitter;
  on(type: string | symbol, pattern, cb?): any {
    const listener = eventListener(this, pattern, cb);
    super.on(type, listener);
    return listener;
  }

  once(type: string | symbol, listener: Function): this; // EventEmitter;
  once(type: string | symbol, pattern, cb?): any /*: () => void */ {        // force any for compatibility
    const listener = eventListener(this, pattern, cb);
    function g() {
      const matches = listener.apply(null, arguments);
      if (matches) this.removeListener(type, g);
    }
    super.on(type, g);
    return g;
  }

  removeAllListeners(type?: string | symbol, subpattern?: string): this {   // EventEmitter
    // If a pattern is specified without an event type, remove all model event
    // listeners under that pattern for all events
    if (!type) {
      for (const key in this._events) {
        this.removeAllListeners(key, subpattern);
      }
      return this;
    }

    const pattern = this.path(subpattern);
    // If no pattern is specified, remove all listeners like normal
    if (!pattern) {
      if (arguments.length === 0) {
        return super.removeAllListeners();
      }
      return super.removeAllListeners(type);
    }

    // Remove all listeners for an event under a pattern
    const listeners = this.listeners(type);
    const segments = pattern.split('.');
    // Make sure to iterate in reverse, since the array might be
    // mutated as listeners are removed
    for (let i = listeners.length; i--; ) {
      const listener = listeners[i];
      if (patternContained(pattern, segments, listener)) {
        this.removeListener(type, listener);
      }
    }
    return this;
  }

  pass(object: Object, invert: boolean = false): ChildModel {
    const model = this._child();
    model._pass = (invert) ?
      new Passed(object, this._pass) :
      new Passed(this._pass, object);
    return model;
  }

  /**
   * The returned Model will or won't trigger event handlers when the model emits
   * events, depending on `value`
   * @param {Boolean|Null} value defaults to true
   * @return {Model}
   */
  silent(value: boolean | null = true): ChildModel {
    const model = this._child();
    model._silent = value;
    return model;
  }

  eventContext(value): ChildModel {
    const model = this._child();
    model._eventContext = value;
    return model;
  }

  removeContextListeners(value): Model {
    if (arguments.length === 0) {
      value = this._eventContext;
    }
    // Remove all events created within a given context
    for (const type in this._events) {
      const listeners: any[] = this.listeners(type);
      // Make sure to iterate in reverse, since the array might be
      // mutated as listeners are removed
      for (let i = listeners.length; i--; ) {
        const listener = listeners[i];
        if (listener.eventContext === value) {
          this.removeListener(type, listener);
        }
      }
    }
    return this;
  }



  ///////////////////////
  // paths
  ///////////////////////


  // TODO: could also be an object with path() function
  _splitPath(subpath?: string | number): string[] {
    const path = this.path(subpath);
    return (path && path.split('.')) || [];
  }

  /**
   * Returns the path equivalent to the path of the current scoped model plus
   * (optionally) a suffix subpath
   *
   * @optional @param {String} subpath
   * @return {String} absolute path
   * @api public
   */
  path(subpath?: string | number | { path: () => string }): string {
    if (subpath == null || subpath === '') return (this._at) ? this._at : '';
    if (typeof subpath === 'string' || typeof subpath === 'number') {
      return (this._at) ? this._at + '.' + subpath : '' + subpath;
    }
    if (typeof subpath.path === 'function') return subpath.path();
  }

  isPath(subpath: string | number | { path: () => string }): boolean {
    return this.path(subpath) != null;
  }

  scope(path: string): ChildModel {
    const model = this._child();
    model._at = path;
    return model;
  }

  /**
   * Create a model object scoped to a particular path.
   * Example:
   *     var user = model.at('users.1');
   *     user.set('username', 'brian');
   *     user.on('push', 'todos', function(todo) {
   *       // ...
   *     });
   *
   *  @param {String} segment
   *  @return {Model} a scoped model
   *  @api public
   */
  at(subpath: string | number | { path: () => string }): ChildModel {
    const path = this.path(subpath);
    return this.scope(path);
  }

  /**
   * Returns a model scope that is a number of levels above the current scoped
   * path. Number of levels defaults to 1, so this method called without
   * arguments returns the model scope's parent model scope.
   *
   * @optional @param {Number} levels
   * @return {Model} a scoped model
   */
  parent(levels: number): ChildModel {
    if (levels == null) levels = 1;
    const segments = this._splitPath();
    const len = Math.max(0, segments.length - levels);
    const path = segments.slice(0, len).join('.');
    return this.scope(path);
  }

  /**
   * Returns the last property segment of the current model scope path
   *
   * @optional @param {String} path
   * @return {String}
   */
  leaf(path: string): string {
    if (!path) path = this.path();
    const i = path.lastIndexOf('.');
    return path.slice(i + 1);
  }


  ///////////////////////
  // collections
  ///////////////////////

  getCollection(collectionName: string) {
    return this.root.collections[collectionName];
  }

  getDoc(collectionName: string, id): Doc {
    const collection = this.root.collections[collectionName];
    return collection && collection.docs[id];
  }

  get(subpath: string) {
    const segments = this._splitPath(subpath);
    return this._get(segments);
  }

  _get(segments: string[]) {
    return util.lookup(segments, this.root.data);
  }

  getCopy(subpath: string) {
    const segments = this._splitPath(subpath);
    return this._getCopy(segments);
  }

  _getCopy(segments: string[]) {
    const value = this._get(segments);
    return util.copy(value);
  }

  getDeepCopy(subpath: string) {
    const segments = this._splitPath(subpath);
    return this._getDeepCopy(segments);
  }

  _getDeepCopy(segments: string[]) {
    const value = this._get(segments);
    return util.deepCopy(value);
  }

  getOrCreateCollection(name: string): Collection {
    let collection = this.root.collections[name];
    if (collection) return collection;
    const Doc = this._getDocConstructor(name);
    collection = new Collection(this.root, name, Doc);
    this.root.collections[name] = collection;
    return collection;
  }

  _getDocConstructor(name?): { new(model: Model, collectionName: string, id: string, data): Doc; } {
    // Only create local documents. This is overriden in ./connection.js, so that
   // the RemoteDoc behavior can be selectively included
    return LocalDoc;
  }

  /**
   * Returns an existing document with id in a collection. If the document does
   * not exist, then creates the document with id in a collection and returns the
   * new document.
   * @param {String} collectionName
   * @param {String} id
   * @param {Object} [data] data to create if doc with id does not exist in collection
   */
  getOrCreateDoc(collectionName: string, id: string, data?): Doc {
    const collection = this.getOrCreateCollection(collectionName);
    return collection.docs[id] || collection.add(id, data);
  }

  /**
   * @param {String} subpath
   */
  destroy(subpath: string): void {
    const segments = this._splitPath(subpath);
    // Silently remove all types of listeners within subpath
    const silentModel = this.silent();
    silentModel.removeAllListeners(null, subpath);
    silentModel._removeAllRefs(segments);
    silentModel._stopAll(segments);
    silentModel._removeAllFilters(segments);
    // Silently remove all model data within subpath
    if (segments.length === 0) {
      this.root.collections = new CollectionMap();
      // Delete each property of data instead of creating a new object so that
      // it is possible to continue using a reference to the original data object
      const data = this.root.data;
      for (const key in data) {
        delete data[key];
      }
    } else if (segments.length === 1) {
      const collection = this.getCollection(segments[0]);
      collection && collection.destroy();
    } else {
      silentModel._del(segments);
    }
  }

}


export class ChildModel extends Model {

  constructor(model: Model) {
    super();

    // Shared properties should be accessed via the root. This makes inheritance
    // cheap and easily extensible
    this.root = model.root;

    // EventEmitter methods access these properties directly, so they must be
    // inherited manually instead of via the root
    this._events = model._events;
    this._maxListeners = model._maxListeners;

    // Properties specific to a child instance
    this._at = model._at;
    this._pass = model._pass;
    this._silent = model._silent;
    this._eventContext = model._eventContext;
    // this._context = model._context;                 // contexts
    // this._preventCompose = model._preventCompose;   // connection
  }
}



Model.INITS.push((model: Model, options: Options) => {
  ///////////////////////
  // events
  ///////////////////////

  // Set max listeners to unlimited
  model.setMaxListeners(0);

  // Used in async methods to emit an error event if a callback is not supplied.
  // This will throw if there is no handler for model.on('error')
  model.root._defaultCallback = defaultCallback;
  function defaultCallback(err) {
    if (err) model._emitError(err);
  }

  model.root._mutatorEventQueue = null;
  model.root._pass = new Passed({}, {});
  model.root._silent = null;
  model.root._eventContext = null;


  ///////////////////////
  // collections
  ///////////////////////

  model.root.collections = new CollectionMap();
  model.root.data = new ModelData();

});




///////////////////////
// events
///////////////////////

function Passed(previous, value) {
  for (var key in previous) {
    this[key] = previous[key];
  }
  for (var key in value) {
    this[key] = value[key];
  }
}

function patternContained(pattern: string, segments: string[], listener) {
  const listenerSegments = listener.patternSegments;
  if (!listenerSegments) return false;
  if (pattern === listener.pattern || pattern === '**') return true;
  const len = segments.length;
  if (len > listenerSegments.length) return false;
  for (let i = 0; i < len; i++) {
    if (segments[i] !== listenerSegments[i]) return false;
  }
  return true;
}

function eventListener(model: Model, subpattern, cb) {
  if (cb) {
    // For signatures:
    // model.on('change', 'example.subpath', callback)
    // model.at('example').on('change', 'subpath', callback)
    const pattern = model.path(subpattern);
    return modelEventListener(pattern, cb, model._eventContext);
  }
  const path = model.path();
  cb = arguments[1];
  // For signature:
  // model.at('example').on('change', callback)
  if (path) return modelEventListener(path, cb, model._eventContext);
  // For signature:
  // model.on('normalEvent', callback)
  return cb;
}

function modelEventListener(pattern, cb, eventContext) {
  const patternSegments = util.castSegments(pattern.split('.'));
  const testFn = testPatternFn(pattern, patternSegments);

  function modelListener(segments: string[], eventArgs) {
    const captures = testFn(segments);
    if (!captures) return;

    const args = (captures.length) ? captures.concat(eventArgs) : eventArgs;
    cb.apply(null, args);
    return true;
  }

  // Used in Model#removeAllListeners
  (<any>modelListener).pattern = pattern;
  (<any>modelListener).patternSegments = patternSegments;
  (<any>modelListener).eventContext = eventContext;

  return modelListener;
}

function testPatternFn(pattern: string, patternSegments): (segments: string[]) => string[] {
  if (pattern === '**') {
    return function testPattern(segments: string[]): string[] {
      return [segments.join('.')];
    };
  }

  const endingRest = stripRestWildcard(patternSegments);

  return function testPattern(segments: string[]): string[] {
    // Any pattern with more segments does not match
    const patternLen = patternSegments.length;
    if (patternLen > segments.length) return;

    // A pattern with the same number of segments matches if each
    // of the segments are wildcards or equal. A shorter pattern matches
    // if it ends in a rest wildcard and each of the corresponding
    // segments are wildcards or equal.
    if (patternLen === segments.length || endingRest) {
      const captures = [];
      for (var i = 0; i < patternLen; i++) {
        const patternSegment = patternSegments[i];
        const segment = segments[i];
        if (patternSegment === '*' || patternSegment === '**') {
          captures.push(segment);
          continue;
        }
        if (patternSegment !== segment) return;
      }
      if (endingRest) {
        const remainder = segments.slice(i).join('.');
        captures.push(remainder);
      }
      return captures;
    }
  };
}

function stripRestWildcard(segments: string[]): boolean {
  // ['example', '**'] -> ['example']; return true
  const lastIndex = segments.length - 1;
  if (segments[lastIndex] === '**') {
    segments.pop();
    return true;
  }
  // ['example', 'subpath**'] -> ['example', 'subpath']; return true
  const match = /^([^\*]+)\*\*$/.exec(segments[lastIndex]);
  if (!match) return false;
  segments[lastIndex] = match[1];
  return true;
}
