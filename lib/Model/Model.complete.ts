import { EventEmitter } from 'events';
import * as uuid        from 'uuid';
import arrayDiff        from 'arraydiff';
import { Connection, defaultType }  from 'sharedb/lib/client';

import CollectionCounter            from './CollectionCounter';
import { Collection, CollectionMap, ModelData } from './collections';
import { Contexts, Context }        from './contexts';
import { Doc }                  from './Doc';
import LocalDoc                 from './LocalDoc';
import RemoteDoc                from './RemoteDoc';
import { Filter, Filters }      from './filter';
import { Fns, NamedFns }        from './fn';
import Query, { Queries }       from './Query';
import { Refs, Ref }            from './ref';
import { RefLists, RefList }    from './refList';

import * as util from '../util';

export default Model;

export interface Options {
  debug?: DebugOptions;
  bundleTimeout?: number;

  // subscriptions
  fetchOnly?: boolean;
  unloadDelay?: number;
}

export interface DebugOptions {
  remoteMutations?: boolean;
  disableSubmit?: boolean;
}


interface Model {
  root: Model;
  debug: DebugOptions;

  // bundle
  bundleTimeout: number;
  _commit: Function;

  // collections
  collections: CollectionMap;
  data: ModelData;

  // connection
  _preventCompose: boolean;
  connection;
  socket;
  _createSocket: (bundle) => any;  // Model::_createSocket should be defined by the socket plugin

  // contexts
  _contexts: Contexts;
  _context: Context;

  // events
  _mutatorEventQueue: [string, string[], any[]][];
  _pass: typeof Passed;
  _silent: boolean;
  _eventContext: any;       // seems like this can really be anything
  _defaultCallback: (err?) => void;

  _events;
  _maxListeners;

  // filter
  _filters: Filters;

  // fn
  _namedFns: NamedFns;
  _fns: Fns;

  // paths
  _at: string;  // this is a path

  // Query
  _queries: Queries;

  // ref
  _refs: Refs;

  // refList
  _refLists: RefLists;

  // subscriptions
  fetchOnly: boolean;
  unloadDelay: number;

  // Track the total number of active fetches per doc
  _fetchedDocs: CollectionCounter;
  // Track the total number of active susbscribes per doc
  _subscribedDocs: CollectionCounter;
}

// bundle.js
Model.INITS.push((model: Model, options: Options) => {
  model.root.bundleTimeout = options.bundleTimeout || Model.BUNDLE_TIMEOUT;
});

// collections
Model.INITS.push((model: Model) => {
  model.root.collections = new CollectionMap();
  model.root.data = new ModelData();
});

// connection
Model.INITS.push((model: Model) => {
  model.root._preventCompose = false;
});

// contexts
Model.INITS.push((model: Model) => {
  model.root._contexts = new Contexts();
  model.root.setContext('root');
});

// events
Model.INITS.push((model: Model) => {
  EventEmitter.call(this);

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
});

// filter
Model.INITS.push((model: Model) => {
  model.root._filters = new Filters(model);
  model.on('all', filterListener);
  function filterListener(segments, eventArgs) {
    const pass = eventArgs[eventArgs.length - 1];
    const map = model.root._filters.fromMap;
    for (const path in map) {
      const filter = map[path];
      if (pass.$filter === filter) continue;
      if (
        util.mayImpact(filter.segments, segments) ||
        (filter.inputsSegments && util.mayImpactAny(filter.inputsSegments, segments))
      ) {
        filter.update(pass);
      }
    }
  }
});

// fn

Model.INITS.push((model: Model) => {
  model.root._namedFns = new NamedFns();
  model.root._fns = new Fns(model);
  model.on('all', fnListener);
  function fnListener(segments: string, eventArgs: any[]) {
    const pass = eventArgs[eventArgs.length - 1];
    const map = model.root._fns.fromMap;
    for (const path in map) {
      const fn = map[path];
      if (pass.$fn === fn) continue;
      if (util.mayImpactAny(fn.inputsSegments, segments)) {
        // Mutation affecting input path
        fn.onInput(pass);
      } else if (util.mayImpact(fn.fromSegments, segments)) {
        // Mutation affecting output path
        fn.onOutput(pass);
      }
    }
  }
});

// query

Model.INITS.push((model: Model) => {
  model.root._queries = new Queries();
});

Model.INITS.push((model: Model) => {
  // refList

  const root = model.root;
  root._refLists = new RefLists();
  for (const type in Model.MUTATOR_EVENTS) {
    addRefListListener(root, type);
  }

  // ref

  root._refs = new Refs();
  addIndexListeners(root);
  addListener(root, 'change', refChange);
  addListener(root, 'load', refLoad);
  addListener(root, 'unload', refUnload);
  addListener(root, 'insert', refInsert);
  addListener(root, 'remove', refRemove);
  addListener(root, 'move', refMove);
});

// subscriptions

Model.INITS.push((model: Model, options) => {
  model.root.fetchOnly = options.fetchOnly;
  model.root.unloadDelay = options.unloadDelay || (util.isServer) ? 0 : 1000;

  // Track the total number of active fetches per doc
  model.root._fetchedDocs = new CollectionCounter();
  // Track the total number of active susbscribes per doc
  model.root._subscribedDocs = new CollectionCounter();
});



class Model extends EventEmitter {
  public static INITS = [];
  public static ChildModel = ChildModel;

  // bundle
  public static BUNDLE_TIMEOUT = 10 * 1000;

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


  /** //////////////////////
  // bundle
  //////////////////////*/

  bundle(cb) {
    const root = this.root;
    const timeout = setTimeout(() => {
      const message = 'Model bundle took longer than ' + root.bundleTimeout + 'ms';
      const err = new Error(message);
      cb(err);
      // Keep the callback from being called more than once
      cb = () => {};
    }, root.bundleTimeout);

    root.whenNothingPending(function finishBundle() {
      clearTimeout(timeout);
      const bundle = {
        queries: root._queries.toJSON(),
        contexts: root._contexts,
        refs: root._refs.toJSON(),
        refLists: root._refLists.toJSON(),
        fns: root._fns.toJSON(),
        filters: root._filters.toJSON(),
        nodeEnv: process.env.NODE_ENV,
        collections: undefined
      };
      stripComputed(root);
      bundle.collections = serializeCollections(root);
      root.emit('bundle', bundle);
      root._commit = errorOnCommit;
      cb(null, bundle);
    });
  }


  /** //////////////////////
  // collections
  //////////////////////*/

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

  __getDocConstructor(name?): { new(model: Model, collectionName: string, id: string, data): Doc; } {
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


  /** //////////////////////
  // connection
  //////////////////////*/

  preventCompose(): ChildModel {
    const model = this._child();
    model._preventCompose = true;
    return model;
  }

  allowCompose(): ChildModel {
    const model = this._child();
    model._preventCompose = false;
    return model;
  }

  createConnection(bundle): void {
    // Model::_createSocket should be defined by the socket plugin
    this.root.socket = this._createSocket(bundle);

    // The Share connection will bind to the socket by defining the onopen,
    // onmessage, etc. methods
    const model = this;
    this.root.connection = new Connection(this.root.socket);
    this.root.connection.on('state', (state, reason) => {
      model._setDiff(['$connection', 'state'], state);
      model._setDiff(['$connection', 'reason'], reason);
    });
    this._set(['$connection', 'state'], 'connected');

    this._finishCreateConnection();
  }

  _finishCreateConnection(): void {
    const model = this;
    this.root.connection.on('error', err => {
      model._emitError(err);
    });
    // Share docs can be created by queries, so we need to register them
    // with Racer as soon as they are created to capture their events
    this.root.connection.on('doc', shareDoc => {
      model.getOrCreateDoc(shareDoc.collection, shareDoc.id);
    });
  }

  connect(): void {
    this.root.socket.open();
  }

  disconnect(): void {
    this.root.socket.close();
  }

  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  // Clean delayed disconnect
  close(cb): void {
    cb = this.wrapCallback(cb);
    const model = this;
    this.whenNothingPending(() => {
      model.root.socket.close();
      cb();
    });
  }

  // Returns a reference to the ShareDB agent if it is connected directly on the
  // server. Will return null if the ShareDB connection has been disconnected or
  // if we are not in the same process and we do not have a reference to the
  // server-side agent object
  getAgent() {
    return this.root.connection.agent;
  }

  _isLocal(name: string): boolean {
    // Whether the collection is local or remote is determined by its name.
    // Collections starting with an underscore ('_') are for user-defined local
    // collections, those starting with a dollar sign ('$'') are for
    // framework-defined local collections, and all others are remote.
    const firstCharcter = name.charAt(0);
    return firstCharcter === '_' || firstCharcter === '$';
  }

  _getDocConstructor(name: string): { new(model: Model, collectionName: string, id: string, data, collection): Doc } {
    return (this._isLocal(name)) ? LocalDoc : RemoteDoc;
  }

  hasPending(): boolean {
    return this.root.connection.hasPending();
  }

  hasWritePending(): boolean {
    return this.root.connection.hasWritePending();
  }

  whenNothingPending(cb) {
    return this.root.connection.whenNothingPending(cb);
  }


  /** //////////////////////
  // contexts
  //////////////////////*/

  context(id: string): ChildModel {
    const model = this._child();
    model.setContext(id);
    return model;
  }

  setContext(id: string): void {
    this._context = this.getOrCreateContext(id);
  }

  getOrCreateContext(id: string): Context {
    const context = this.root._contexts[id] ||
      (this.root._contexts[id] = new Context(this, id));
    return context;
  }

  unload(id?: string): void {
    const context = (id) ? this.root._contexts[id] : this._context;
    context && context.unload();
  }

  unloadAll(): void {
    const contexts = this.root._contexts;
    for (const key in contexts) {
      contexts[key].unload();
    }
  }

  /** //////////////////////
  // events
  //////////////////////*/

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

  /** //////////////////////
  // filter
  //////////////////////*/

  filter(path: string, fn: Function): Filter;
  filter(path: string, options: Object, fn: Function): Filter;
  filter(path: string, inputPath1: string, fn: Function): Filter;
  filter(path: string, inputPath1: string, options: Object, fn: Function): Filter;
  filter(path: string, inputPath1: string, inputPath2: string, fn: Function): Filter;
  filter(path: string, inputPath1: string, inputPath2: string, options: Object, fn: Function): Filter;
  filter(): Filter {
    const args = Array.prototype.slice.call(arguments);
    const parsed = parseFilterArguments(this, args);
    return this.root._filters.add(
      parsed.path,
      parsed.fn,
      null,
      parsed.inputPaths,
      parsed.options
    );
  }

  sort(path: string, fn: Function): Filter;
  sort(path: string, options: Object, fn: Function): Filter;
  sort(path: string, inputPath1: string, fn: Function): Filter;
  sort(path: string, inputPath1: string, options: Object, fn: Function): Filter;
  sort(path: string, inputPath1: string, inputPath2: string, fn: Function): Filter;
  sort(path: string, inputPath1: string, inputPath2: string, options: Object, fn: Function): Filter;
  sort(): Filter {
    const args = Array.prototype.slice.call(arguments);
    const parsed = parseFilterArguments(this, args);
    return this.root._filters.add(
      parsed.path,
      null,
      parsed.fn || 'asc',
      parsed.inputPaths,
      parsed.options
    );
  }

  removeAllFilters(subpath?: string): void {
    const segments = this._splitPath(subpath);
    this._removeAllFilters(segments);
  }

  _removeAllFilters(segments: string[]): void {
    const filters = this.root._filters.fromMap;
    for (const from in filters) {
      if (util.contains(segments, filters[from].fromSegments)) {
        filters[from].destroy();
      }
    }
  }


  /** //////////////////////
  // fn
  //////////////////////*/

  fn(name: string, fns): void {
    this.root._namedFns[name] = fns;
  }

  evaluate() {
    const args = Array.prototype.slice.call(arguments);
    const parsed = parseStartArguments(this, args, false);
    return this.root._fns.get(parsed.name, parsed.inputPaths, parsed.fns, parsed.options);
  }

  start() {
    const args = Array.prototype.slice.call(arguments);
    const parsed = parseStartArguments(this, args, true);
    return this.root._fns.start(parsed.name, parsed.path, parsed.inputPaths, parsed.fns, parsed.options);
  }

  stop(subpath: string | number): void {
    const path = this.path(subpath);
    this._stop(path);
  }

  _stop(fromPath): void {
    this.root._fns.stop(fromPath);
  }

  stopAll(subpath: string | number): void {
    const segments = this._splitPath(subpath);
    this._stopAll(segments);
  }

  _stopAll(segments: string[]): void {
    const fns = this.root._fns.fromMap;
    for (const from in fns) {
      const fromSegments = fns[from].fromSegments;
      if (util.contains(segments, fromSegments)) {
        this._stop(from);
      }
    }
  }


  /** //////////////////////
  // mutators
  //////////////////////*/

  _mutate(segments: string[], fn, cb) {
    cb = this.wrapCallback(cb);
    const collectionName = segments[0];
    const id = segments[1];
    if (!collectionName || !id) {
      const message = fn.name + ' must be performed under a collection ' +
        'and document id. Invalid path: ' + segments.join('.');
      return cb(new Error(message));
    }
    const doc = this.getOrCreateDoc(collectionName, id);
    const docSegments = segments.slice(2);
    if (this._preventCompose && doc.shareDoc) {
      const oldPreventCompose = doc.shareDoc.preventCompose;
      doc.shareDoc.preventCompose = true;
      const out = fn(doc, docSegments, cb);
      doc.shareDoc.preventCompose = oldPreventCompose;
      return out;
    }
    return fn(doc, docSegments, cb);
  }

  set() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._set(segments, value, cb);
  }

  _set(segments: string[], value, cb?: Function) {
    segments = this._dereference(segments);
    const model = this;
    function set(doc: Doc, docSegments: string[], fnCb: Function) {
      const previous = doc.set(docSegments, value, fnCb);
      // On setting the entire doc, remote docs sometimes do a copy to add the
      // id without it being stored in the database by ShareJS
      if (docSegments.length === 0) value = doc.get(docSegments);
      model.emit('change', segments, [value, previous, model._pass]);
      return previous;
    }
    return this._mutate(segments, set, cb);
  }

  setNull() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setNull(segments, value, cb);
  }

  _setNull(segments: string[], value, cb) {
    segments = this._dereference(segments);
    const model = this;
    function setNull(doc: Doc, docSegments: string[], fnCb: Function) {
      const previous = doc.get(docSegments);
      if (previous != null) {
        fnCb();
        return previous;
      }
      doc.set(docSegments, value, fnCb);
      model.emit('change', segments, [value, previous, model._pass]);
      return value;
    }
    return this._mutate(segments, setNull, cb);
  }

  setEach() {
    let subpath, object, cb;
    if (arguments.length === 1) {
      object = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      object = arguments[1];
    } else {
      subpath = arguments[0];
      object = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setEach(segments, object, cb);
  }

  _setEach(segments: string[], object, cb) {
    segments = this._dereference(segments);
    const group = util.asyncGroup(this.wrapCallback(cb));
    for (const key in object) {
      const value = object[key];
      this._set(segments.concat(key), value, group());
    }
  }

  create() {
    let subpath, value, cb;
    if (arguments.length === 0) {
      value = {};
    } else if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        value = {};
        cb = arguments[0];
      } else {
        value = arguments[0];
      }
    } else if (arguments.length === 2) {
      if (typeof arguments[1] === 'function') {
        value = arguments[0];
        cb = arguments[1];
      } else {
        subpath = arguments[0];
        value = arguments[1];
      }
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._create(segments, value, cb);
  }

  _create(segments: string[], value, cb) {
    segments = this._dereference(segments);
    if (segments.length !== 2) {
      const message = 'create may only be used on a document path. ' +
        'Invalid path: ' + segments.join('.');
      cb = this.wrapCallback(cb);
      return cb(new Error(message));
    }
    const model = this;
    function create(doc, docSegments, fnCb) {
      let previous;
      doc.create(value, fnCb);
      // On creating the doc, remote docs do a copy to add the id without
      // it being stored in the database by ShareJS
      value = doc.get();
      model.emit('change', segments, [value, previous, model._pass]);
    }
    this._mutate(segments, create, cb);
  }

  createNull() {
    let subpath, value, cb;
    if (arguments.length === 0) {
      value = {};
    } else if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        value = {};
        cb = arguments[0];
      } else {
        value = arguments[0];
      }
    } else if (arguments.length === 2) {
      if (typeof arguments[1] === 'function') {
        value = arguments[0];
        cb = arguments[1];
      } else {
        subpath = arguments[0];
        value = arguments[1];
      }
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._createNull(segments, value, cb);
  }

  _createNull(segments: string[], value, cb) {
    segments = this._dereference(segments);
    const doc = this.getDoc(segments[0], segments[1]);
    if (doc && doc.get() != null) return;
    this._create(segments, value, cb);
  }

  add() {
    let subpath, value, cb;
    if (arguments.length === 0) {
      value = {};
    } else if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        value = {};
        cb = arguments[0];
      } else {
        value = arguments[0];
      }
    } else if (arguments.length === 2) {
      if (typeof arguments[1] === 'function') {
        value = arguments[0];
        cb = arguments[1];
      } else {
        subpath = arguments[0];
        value = arguments[1];
      }
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._add(segments, value, cb);
  }

  _add(segments: string[], value: any, cb) {
    if (typeof value !== 'object') {
      const message = 'add requires an object value. Invalid value: ' + value;
      cb = this.wrapCallback(cb);
      return cb(new Error(message));
    }
    const id = value.id || this.id();
    value.id = id;
    segments = this._dereference(segments.concat(id));
    const model = this;
    function add(doc, docSegments, fnCb) {
      let previous;
      if (docSegments.length) {
        previous = doc.set(docSegments, value, fnCb);
      } else {
        doc.create(value, fnCb);
        // On creating the doc, remote docs do a copy to add the id without
        // it being stored in the database by ShareJS
        value = doc.get();
      }
      model.emit('change', segments, [value, previous, model._pass]);
    }
    this._mutate(segments, add, cb);
    return id;
  }

  del() {
    let subpath, cb;
    if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        cb = arguments[0];
      } else {
        subpath = arguments[0];
      }
    } else {
      subpath = arguments[0];
      cb = arguments[1];
    }
    const segments = this._splitPath(subpath);
    return this._del(segments, cb);
  }

  _del(segments: string[], cb?) {
    segments = this._dereference(segments);
    const model = this;
    function del(doc, docSegments, fnCb) {
      const previous = doc.del(docSegments, fnCb);
      // When deleting an entire document, also remove the reference to the
      // document object from its collection
      if (segments.length === 2) {
        const collectionName = segments[0];
        const id = segments[1];
        model.root.collections[collectionName].remove(id);
      }
      model.emit('change', segments, [undefined, previous, model._pass]);
      return previous;
    }
    return this._mutate(segments, del, cb);
  }

  increment() {
    let subpath, byNumber, cb;
    if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        cb = arguments[0];
      } else if (typeof arguments[0] === 'number') {
        byNumber = arguments[0];
      } else {
        subpath = arguments[0];
      }
    } else if (arguments.length === 2) {
      if (typeof arguments[1] === 'function') {
        cb = arguments[1];
        if (typeof arguments[0] === 'number') {
          byNumber = arguments[0];
        } else {
          subpath = arguments[0];
        }
      } else {
        subpath = arguments[0];
        byNumber = arguments[1];
      }
    } else {
      subpath = arguments[0];
      byNumber = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._increment(segments, byNumber, cb);
  }

  _increment(segments: string[], byNumber: number, cb) {
    segments = this._dereference(segments);
    if (byNumber == null) byNumber = 1;
    const model = this;
    function increment(doc, docSegments, fnCb) {
      const value = doc.increment(docSegments, byNumber, fnCb);
      const previous = value - byNumber;
      model.emit('change', segments, [value, previous, model._pass]);
      return value;
    }
    return this._mutate(segments, increment, cb);
  }

  push() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._push(segments, value, cb);
  }

  _push(segments: string[], value, cb) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    const model = this;
    function push(doc, docSegments, fnCb) {
      const length = doc.push(docSegments, value, fnCb);
      model.emit('insert', segments, [length - 1, [value], model._pass]);
      return length;
    }
    return this._mutate(segments, push, cb);
  }

  unshift() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._unshift(segments, value, cb);
  }

  _unshift(segments: string[], value, cb) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    const model = this;
    function unshift(doc, docSegments, fnCb) {
      const length = doc.unshift(docSegments, value, fnCb);
      model.emit('insert', segments, [0, [value], model._pass]);
      return length;
    }
    return this._mutate(segments, unshift, cb);
  }

  insert() {
    let subpath, index, values, cb;
    if (arguments.length < 2) {
      throw new Error('Not enough arguments for insert');
    } else if (arguments.length === 2) {
      index = arguments[0];
      values = arguments[1];
    } else if (arguments.length === 3) {
      subpath = arguments[0];
      index = arguments[1];
      values = arguments[2];
    } else {
      subpath = arguments[0];
      index = arguments[1];
      values = arguments[2];
      cb = arguments[3];
    }
    const segments = this._splitPath(subpath);
    return this._insert(segments, +index, values, cb);
  }

  _insert(segments: string[], index: number, values, cb?) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    const model = this;
    function insert(doc, docSegments, fnCb) {
      const inserted = (Array.isArray(values)) ? values : [values];
      const length = doc.insert(docSegments, index, inserted, fnCb);
      model.emit('insert', segments, [index, inserted, model._pass]);
      return length;
    }
    return this._mutate(segments, insert, cb);
  }

  pop() {
    let subpath, cb;
    if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        cb = arguments[0];
      } else {
        subpath = arguments[0];
      }
    } else {
      subpath = arguments[0];
      cb = arguments[1];
    }
    const segments = this._splitPath(subpath);
    return this._pop(segments, cb);
  }

  _pop(segments: string[], cb) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    const model = this;
    function pop(doc, docSegments, fnCb) {
      const arr = doc.get(docSegments);
      const length = arr && arr.length;
      if (!length) {
        fnCb();
        return;
      }
      const value = doc.pop(docSegments, fnCb);
      model.emit('remove', segments, [length - 1, [value], model._pass]);
      return value;
    }
    return this._mutate(segments, pop, cb);
  }

  shift() {
    let subpath, cb;
    if (arguments.length === 1) {
      if (typeof arguments[0] === 'function') {
        cb = arguments[0];
      } else {
        subpath = arguments[0];
      }
    } else {
      subpath = arguments[0];
      cb = arguments[1];
    }
    const segments = this._splitPath(subpath);
    return this._shift(segments, cb);
  }

  _shift(segments: string[], cb) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    const model = this;
    function shift(doc, docSegments, fnCb) {
      const arr = doc.get(docSegments);
      const length = arr && arr.length;
      if (!length) {
        fnCb();
        return;
      }
      const value = doc.shift(docSegments, fnCb);
      model.emit('remove', segments, [0, [value], model._pass]);
      return value;
    }
    return this._mutate(segments, shift, cb);
  }

  remove() {
    let subpath, index, howMany, cb;
    if (arguments.length < 2) {
      index = arguments[0];
    } else if (arguments.length === 2) {
      if (typeof arguments[1] === 'function') {
        cb = arguments[1];
        if (typeof arguments[0] === 'number') {
          index = arguments[0];
        } else {
          subpath = arguments[0];
        }
      } else {
        // eslint-disable-next-line no-lonely-if
        if (typeof arguments[0] === 'number') {
          index = arguments[0];
          howMany = arguments[1];
        } else {
          subpath = arguments[0];
          index = arguments[1];
        }
      }
    } else if (arguments.length === 3) {
      if (typeof arguments[2] === 'function') {
        cb = arguments[2];
        if (typeof arguments[0] === 'number') {
          index = arguments[0];
          howMany = arguments[1];
        } else {
          subpath = arguments[0];
          index = arguments[1];
        }
      } else {
        subpath = arguments[0];
        index = arguments[1];
        howMany = arguments[2];
      }
    } else {
      subpath = arguments[0];
      index = arguments[1];
      howMany = arguments[2];
      cb = arguments[3];
    }
    const segments = this._splitPath(subpath);
    if (index == null) index = segments.pop();
    return this._remove(segments, +index, howMany, cb);
  }

  _remove(segments: string[], index: number, howMany: number, cb?) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    if (howMany == null) howMany = 1;
    const model = this;
    function remove(doc, docSegments, fnCb) {
      const removed = doc.remove(docSegments, index, howMany, fnCb);
      model.emit('remove', segments, [index, removed, model._pass]);
      return removed;
    }
    return this._mutate(segments, remove, cb);
  }

  move() {
    let subpath, from, to, howMany, cb;
    if (arguments.length < 2) {
      throw new Error('Not enough arguments for move');
    } else if (arguments.length === 2) {
      from = arguments[0];
      to = arguments[1];
    } else if (arguments.length === 3) {
      if (typeof arguments[2] === 'function') {
        from = arguments[0];
        to = arguments[1];
        cb = arguments[2];
      } else if (typeof arguments[0] === 'number') {
        from = arguments[0];
        to = arguments[1];
        howMany = arguments[2];
      } else {
        subpath = arguments[0];
        from = arguments[1];
        to = arguments[2];
      }
    } else if (arguments.length === 4) {
      if (typeof arguments[3] === 'function') {
        cb = arguments[3];
        if (typeof arguments[0] === 'number') {
          from = arguments[0];
          to = arguments[1];
          howMany = arguments[2];
        } else {
          subpath = arguments[0];
          from = arguments[1];
          to = arguments[2];
        }
      } else {
        subpath = arguments[0];
        from = arguments[1];
        to = arguments[2];
        howMany = arguments[3];
      }
    } else {
      subpath = arguments[0];
      from = arguments[1];
      to = arguments[2];
      howMany = arguments[3];
      cb = arguments[4];
    }
    const segments = this._splitPath(subpath);
    return this._move(segments, from, to, howMany, cb);
  }

  _move(segments: string[], from: number, to: number, howMany: number, cb?: Function) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    if (howMany == null) howMany = 1;
    const model = this;
    function move(doc: Doc, docSegments: string[], fnCb: Function) {
      // Cast to numbers
      from = +from;
      to = +to;
      // Convert negative indices into positive
      if (from < 0 || to < 0) {
        const len = doc.get(docSegments).length;
        if (from < 0) from += len;
        if (to < 0) to += len;
      }
      const moved = doc.move(docSegments, from, to, howMany, fnCb);
      model.emit('move', segments, [from, to, moved.length, model._pass]);
      return moved;
    }
    return this._mutate(segments, move, cb);
  }

  stringInsert() {
    let subpath, index, text, cb;
    if (arguments.length < 2) {
      throw new Error('Not enough arguments for stringInsert');
    } else if (arguments.length === 2) {
      index = arguments[0];
      text = arguments[1];
    } else if (arguments.length === 3) {
      if (typeof arguments[2] === 'function') {
        index = arguments[0];
        text = arguments[1];
        cb = arguments[2];
      } else {
        subpath = arguments[0];
        index = arguments[1];
        text = arguments[2];
      }
    } else {
      subpath = arguments[0];
      index = arguments[1];
      text = arguments[2];
      cb = arguments[3];
    }
    const segments = this._splitPath(subpath);
    return this._stringInsert(segments, index, text, cb);
  }

  _stringInsert(segments: string[], index, text, cb) {
    segments = this._dereference(segments);
    const model = this;
    function stringInsert(doc, docSegments, fnCb) {
      const previous = doc.stringInsert(docSegments, index, text, fnCb);
      const value = doc.get(docSegments);
      const pass = model.pass({$stringInsert: {index: index, text: text}})._pass;
      model.emit('change', segments, [value, previous, pass]);
      return;
    }
    return this._mutate(segments, stringInsert, cb);
  }

  stringRemove() {
    let subpath, index, howMany, cb;
    if (arguments.length < 2) {
      throw new Error('Not enough arguments for stringRemove');
    } else if (arguments.length === 2) {
      index = arguments[0];
      howMany = arguments[1];
    } else if (arguments.length === 3) {
      if (typeof arguments[2] === 'function') {
        index = arguments[0];
        howMany = arguments[1];
        cb = arguments[2];
      } else {
        subpath = arguments[0];
        index = arguments[1];
        howMany = arguments[2];
      }
    } else {
      subpath = arguments[0];
      index = arguments[1];
      howMany = arguments[2];
      cb = arguments[3];
    }
    const segments = this._splitPath(subpath);
    return this._stringRemove(segments, index, howMany, cb);
  }

  _stringRemove(segments: string[], index, howMany, cb) {
    segments = this._dereference(segments);
    const model = this;
    function stringRemove(doc, docSegments, fnCb) {
      const previous = doc.stringRemove(docSegments, index, howMany, fnCb);
      const value = doc.get(docSegments);
      const pass = model.pass({$stringRemove: {index: index, howMany: howMany}})._pass;
      model.emit('change', segments, [value, previous, pass]);
      return;
    }
    return this._mutate(segments, stringRemove, cb);
  }

  subtypeSubmit() {
    let subpath, subtype, subtypeOp, cb;
    if (arguments.length < 2) {
      throw new Error('Not enough arguments for subtypeSubmit');
    } else if (arguments.length === 2) {
      subtype = arguments[0];
      subtypeOp = arguments[1];
    } else if (arguments.length === 3) {
      if (typeof arguments[2] === 'function') {
        subtype = arguments[0];
        subtypeOp = arguments[1];
        cb = arguments[2];
      } else {
        subpath = arguments[0];
        subtype = arguments[1];
        subtypeOp = arguments[2];
      }
    } else {
      subpath = arguments[0];
      subtype = arguments[1];
      subtypeOp = arguments[2];
      cb = arguments[3];
    }
    const segments = this._splitPath(subpath);
    return this._subtypeSubmit(segments, subtype, subtypeOp, cb);
  }

  _subtypeSubmit(segments: string[], subtype, subtypeOp, cb) {
    segments = this._dereference(segments);
    const model = this;
    function subtypeSubmit(doc, docSegments, fnCb) {
      const previous = doc.subtypeSubmit(docSegments, subtype, subtypeOp, fnCb);
      const value = doc.get(docSegments);
      const pass = model.pass({$subtype: {type: subtype, op: subtypeOp}})._pass;
      // Emit undefined for the previous value, since we don't really know
      // whether or not the previous value returned by the subtypeSubmit is the
      // same object returned by reference or not. This may cause change
      // listeners to over-trigger, but that is usually going to be better than
      // under-triggering
      model.emit('change', segments, [value, undefined, pass]);
      return previous;
    }
    return this._mutate(segments, subtypeSubmit, cb);
  }


  /** //////////////////////
  // paths
  //////////////////////*/


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


  /** //////////////////////
  // Query
  //////////////////////*/

  query(collectionName: string, expression, options): Query {
    expression = this.sanitizeQuery(expression);
    // DEPRECATED: Passing in a string as the third argument specifies the db
    // option for backward compatibility
    if (typeof options === 'string') {
      options = {db: options};
    }
    let query = this.root._queries.get(collectionName, expression, options);
    if (query) return query;
    query = new Query(this, collectionName, expression, options);
    this.root._queries.add(query);
    return query;
  }

  // This method replaces undefined in query objects with null, because
  // undefined properties are removed in JSON stringify. This can be dangerous
  // in queries, where presenece of a property may indicate that it should be a
  // filter and absence means that all values are accepted. We aren't checking
  // for cycles, which aren't allowed in JSON, so this could throw a max call
  // stack error
  sanitizeQuery(expression) {
    if (expression && typeof expression === 'object') {
      for (const key in expression) {
        if (expression.hasOwnProperty(key)) {
          const value = expression[key];
          if (value === undefined) {
            expression[key] = null;
          } else {
            this.sanitizeQuery(value);
          }
        }
      }
    }
    return expression;
  }

  // Called during initialization of the bundle on page load.
  _initQueries(items) {
    const queries = this.root._queries;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const counts = item[0];
      const collectionName = item[1];
      const expression = item[2];
      const results = item[3] || [];
      const options = item[4];
      const extra = item[5];
      const query = new Query(this, collectionName, expression, options);
      queries.add(query);
      query._setExtra(extra);

      const ids = [];
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex];
        if (typeof result === 'string') {
          ids.push(result);
          continue;
        }
        const data = result[0];
        const v = result[1];
        const id = result[2] || data.id;
        const type = result[3];
        ids.push(id);
        const snapshot = {data: data, v: v, type: type};
        this.getOrCreateDoc(collectionName, id, snapshot);
      }
      query._addMapIds(ids);
      this._set(query.idsSegments, ids);

      for (let countIndex = 0; countIndex < counts.length; countIndex++) {
        const count = counts[countIndex];
        let subscribed = count[0] || 0;
        let fetched = count[1] || 0;
        const contextId = count[2];
        if (contextId) query.model.setContext(contextId);
        while (subscribed--) {
          query.subscribe();
        }
        query.fetchCount += fetched;
        while (fetched--) {
          query.model._context.fetchQuery(query);
        }
      }
    }
  }


  /** //////////////////////
  // ref
  //////////////////////*/

  _canRefTo(value): boolean {
    return this.isPath(value) || (value && typeof value.ref === 'function');
  }

  ref(to: string, options?: { updateIndices: boolean }): ChildModel;
  ref(from: string, to: string | Query | Filter, options?: { updateIndices: boolean }): ChildModel;
  ref(): ChildModel {
    let from, to, options;
    if (arguments.length === 1) {
      to = arguments[0];
    } else if (arguments.length === 2) {
      if (this._canRefTo(arguments[1])) {
        from = arguments[0];
        to = arguments[1];
      } else {
        to = arguments[0];
        options = arguments[1];
      }
    } else {
      from = arguments[0];
      to = arguments[1];
      options = arguments[2];
    }
    const fromPath = this.path(from);
    const toPath = this.path(to);
    // Make ref to reffable object, such as query or filter
    if (!toPath) return to.ref(fromPath);
    const ref = new Ref(this.root, fromPath, toPath, options);
    if (ref.fromSegments.length < 2) {
      throw new Error('ref must be performed under a collection ' +
        'and document id. Invalid path: ' + fromPath);
    }
    this.root._refs.remove(fromPath);
    this.root._refLists.remove(fromPath);
    const value = this.get(to);
    ref.model._set(ref.fromSegments, value);
    this.root._refs.add(ref);
    return this.scope(fromPath);
  }

  removeRef(subpath: string|number): void {
    const segments = this._splitPath(subpath);
    const fromPath = segments.join('.');
    this._removeRef(segments, fromPath);
  }

  _removeRef(segments: string[], fromPath: string): void {
    this.root._refs.remove(fromPath);
    this.root._refLists.remove(fromPath);
    this._del(segments);
  }

  removeAllRefs(subpath: string | number): void {
    const segments = this._splitPath(subpath);
    this._removeAllRefs(segments);
  }

  _removeAllRefs(segments: string[]): void {
    this._removePathMapRefs(segments, this.root._refs.fromPathMap);
    this._removeMapRefs(segments, this.root._refLists.fromMap);
  }

  _removePathMapRefs(segments: string[], map): void {
    const refs = map.getList(segments);
    for (let i = 0, len = refs.length; i < len; i++) {
      const ref = refs[i];
      this._removeRef(ref.fromSegments, ref.from);
    }
  }

  _removeMapRefs(segments: string[], map): void {
    for (const from in map) {
      const fromSegments = map[from].fromSegments;
      if (util.contains(segments, fromSegments)) {
        this._removeRef(fromSegments, from);
      }
    }
  }

  dereference(subpath) {
    const segments = this._splitPath(subpath);
    return this._dereference(segments).join('.');
  }

  _dereference(segments: string[], forArrayMutator?, ignore?) {
    if (segments.length === 0) return segments;
    const refs = this.root._refs.fromPathMap;
    const refLists = this.root._refLists.fromMap;
    let doAgain;
    do {
      let subpath = '';
      doAgain = false;
      for (let i = 0, len = segments.length; i < len; i++) {
        subpath = (subpath) ? subpath + '.' + segments[i] : segments[i];

        const ref = refs.get(subpath.split('.'));
        if (ref) {
          const remaining = segments.slice(i + 1);
          segments = ref.toSegments.concat(remaining);
          doAgain = true;
          break;
        }

        const refList = refLists[subpath];
        if (refList && refList !== ignore) {
          const belowDescendant = i + 2 < len;
          const belowChild = i + 1 < len;
          if (!(belowDescendant || forArrayMutator && belowChild)) continue;
          segments = refList.dereference(segments, i);
          doAgain = true;
          break;
        }
      }
    } while (doAgain);
    // If a dereference fails, return a path that will result in a null value
    // instead of a path to everything in the model
    if (segments.length === 0) return ['$null'];
    return segments;
  }


  /** //////////////////////
  // refList
  //////////////////////*/

  refList(from: string, to: string, ids: string, options?: { deleteRemoved: boolean }): ChildModel
  refList(to: string, ids: string, options?: { deleteRemoved: boolean }): ChildModel
  refList(): ChildModel {
    let from, to, ids, options;
    if (arguments.length === 2) {
      to = arguments[0];
      ids = arguments[1];
    } else if (arguments.length === 3) {
      if (this.isPath(arguments[2])) {
        from = arguments[0];
        to = arguments[1];
        ids = arguments[2];
      } else {
        to = arguments[0];
        ids = arguments[1];
        options = arguments[2];
      }
    } else {
      from = arguments[0];
      to = arguments[1];
      ids = arguments[2];
      options = arguments[3];
    }
    const fromPath = this.path(from);
    let toPath;
    if (Array.isArray(to)) {
      toPath = [];
      for (let i = 0; i < to.length; i++) {
        toPath.push(this.path(to[i]));
      }
    } else {
      toPath = this.path(to);
    }
    const idsPath = this.path(ids);
    const refList = new RefList(this.root, fromPath, toPath, idsPath, options);
    this.root._refLists.remove(fromPath);
    refList.model._setArrayDiff(refList.fromSegments, refList.get());
    this.root._refLists.add(refList);
    return this.scope(fromPath);
  }


  /** //////////////////////
  // setDiff
  //////////////////////*/


  setDiff() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setDiff(segments, value, cb);
  }

  _setDiff(segments, value, cb?) {
    segments = this._dereference(segments);
    const model = this;
    function setDiff(doc, docSegments, fnCb) {
      const previous = doc.get(docSegments);
      if (util.equal(previous, value)) {
        fnCb();
        return previous;
      }
      doc.set(docSegments, value, fnCb);
      model.emit('change', segments, [value, previous, model._pass]);
      return previous;
    }
    return this._mutate(segments, setDiff, cb);
  }

  setDiffDeep() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setDiffDeep(segments, value, cb);
  }

  _setDiffDeep(segments, value, cb?) {
    const before = this._get(segments);
    cb = this.wrapCallback(cb);
    const group = util.asyncGroup(cb);
    const finished = group();
    diffDeep(this, segments, before, value, group);
    finished();
  }

  setArrayDiff() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setArrayDiff(segments, value, cb);
  }

  setArrayDiffDeep() {
    let subpath, value, cb;
    if (arguments.length === 1) {
      value = arguments[0];
    } else if (arguments.length === 2) {
      subpath = arguments[0];
      value = arguments[1];
    } else {
      subpath = arguments[0];
      value = arguments[1];
      cb = arguments[2];
    }
    const segments = this._splitPath(subpath);
    return this._setArrayDiffDeep(segments, value, cb);
  }

  _setArrayDiffDeep(segments: string[], value, cb?) {
    return this._setArrayDiff(segments, value, cb, util.deepEqual);
  }

  _setArrayDiff(segments: string[], value, cb?, _equalFn?) {
    const before = this._get(segments);
    if (before === value) return this.wrapCallback(cb)();
    if (!Array.isArray(before) || !Array.isArray(value)) {
      this._set(segments, value, cb);
      return;
    }
    const diff = arrayDiff(before, value, _equalFn);
    this._applyArrayDiff(segments, diff, cb);
  }

  _applyArrayDiff(segments, diff, cb?) {
    if (!diff.length) return this.wrapCallback(cb)();
    segments = this._dereference(segments);
    const model = this;
    function applyArrayDiff(doc, docSegments, fnCb) {
      const group = util.asyncGroup(fnCb);
      for (let i = 0, len = diff.length; i < len; i++) {
        const item = diff[i];
        if (item instanceof arrayDiff.InsertDiff) {
          // Insert
          doc.insert(docSegments, item.index, item.values, group());
          model.emit('insert', segments, [item.index, item.values, model._pass]);
        } else if (item instanceof arrayDiff.RemoveDiff) {
          // Remove
          const removed = doc.remove(docSegments, item.index, item.howMany, group());
          model.emit('remove', segments, [item.index, removed, model._pass]);
        } else if (item instanceof arrayDiff.MoveDiff) {
          // Move
          const moved = doc.move(docSegments, item.from, item.to, item.howMany, group());
          model.emit('move', segments, [item.from, item.to, moved.length, model._pass]);
        }
      }
    }
    return this._mutate(segments, applyArrayDiff, cb);
  }

  /** //////////////////////
  // subscriptions
  //////////////////////*/

  fetch() {
    this._forSubscribable(arguments, 'fetch');
    return this;
  }

  unfetch() {
    this._forSubscribable(arguments, 'unfetch');
    return this;
  }

  subscribe() {
    this._forSubscribable(arguments, 'subscribe');
    return this;
  }

  unsubscribe() {
    this._forSubscribable(arguments, 'unsubscribe');
    return this;
  }

  _forSubscribable(argumentsObject, method) {
    let args, cb;
    if (!argumentsObject.length) {
      // Use this model's scope if no arguments
      args = [null];
    } else if (typeof argumentsObject[0] === 'function') {
      // Use this model's scope if the first argument is a callback
      args = [null];
      cb = argumentsObject[0];
    } else if (Array.isArray(argumentsObject[0])) {
      // Items can be passed in as an array
      args = argumentsObject[0];
      cb = argumentsObject[1];
    } else {
      // Or as multiple arguments
      args = Array.prototype.slice.call(argumentsObject);
      const last = args[args.length - 1];
      if (typeof last === 'function') cb = args.pop();
    }

    const group = util.asyncGroup(this.wrapCallback(cb));
    const finished = group();
    const docMethod = method + 'Doc';

    this.root.connection.startBulk();
    for (let i = 0; i < args.length; i++) {
      const item = args[i];
      if (item instanceof Query) {
        item[method](group());
      } else {
        const segments = this._dereference(this._splitPath(item));
        if (segments.length === 2) {
          // Do the appropriate method for a single document.
          this[docMethod](segments[0], segments[1], group());
        } else {
          const message = 'Cannot ' + method + ' to path: ' + segments.join('.');
          group()(new Error(message));
        }
      }
    }
    this.root.connection.endBulk();
    process.nextTick(finished);
  }

  fetchDoc(collectionName: string, id: string, cb?) {
    cb = this.wrapCallback(cb);

    // Maintain a count of fetches so that we can unload the document
    // when there are no remaining fetches or subscribes for that document
    this._context.fetchDoc(collectionName, id);
    this.root._fetchedDocs.increment(collectionName, id);

    // Fetch
    const doc = this.getOrCreateDoc(collectionName, id);
    doc.shareDoc.fetch(cb);
  }

  subscribeDoc(collectionName: string, id: string, cb?) {
    cb = this.wrapCallback(cb);

    // Maintain a count of subscribes so that we can unload the document
    // when there are no remaining fetches or subscribes for that document
    this._context.subscribeDoc(collectionName, id);
    this.root._subscribedDocs.increment(collectionName, id);

    const doc = this.getOrCreateDoc(collectionName, id);
    // Early return if we know we are already subscribed
    if (doc.shareDoc.subscribed) {
      return cb();
    }
    // Subscribe
    if (this.root.fetchOnly) {
      doc.shareDoc.fetch(cb);
    } else {
      doc.shareDoc.subscribe(cb);
    }
  }

  unfetchDoc(collectionName: string, id: string, cb?) {
    cb = this.wrapCallback(cb);
    this._context.unfetchDoc(collectionName, id);

    // No effect if the document is not currently fetched
    if (!this.root._fetchedDocs.get(collectionName, id)) return cb();

    const model = this;
    if (this.root.unloadDelay) {
      setTimeout(finishUnfetchDoc, this.root.unloadDelay);
    } else {
      finishUnfetchDoc();
    }
    function finishUnfetchDoc() {
      const count = model.root._fetchedDocs.decrement(collectionName, id);
      if (count) return cb(null, count);
      model._maybeUnloadDoc(collectionName, id);
      cb(null, 0);
    }
  }

  unsubscribeDoc(collectionName: string, id: string, cb?) {
    cb = this.wrapCallback(cb);
    this._context.unsubscribeDoc(collectionName, id);

    // No effect if the document is not currently subscribed
    if (!this.root._subscribedDocs.get(collectionName, id)) return cb();

    const model = this;
    if (this.root.unloadDelay) {
      setTimeout(finishUnsubscribeDoc, this.root.unloadDelay);
    } else {
      finishUnsubscribeDoc();
    }
    function finishUnsubscribeDoc() {
      const count = model.root._subscribedDocs.decrement(collectionName, id);
      // If there are more remaining subscriptions, only decrement the count
      // and callback with how many subscriptions are remaining
      if (count) return cb(null, count);

      // If there is only one remaining subscription, actually unsubscribe
      if (model.root.fetchOnly) {
        unsubscribeDocCallback();
      } else {
        const doc = model.getDoc(collectionName, id);
        const shareDoc = doc && doc.shareDoc;
        if (!shareDoc) return unsubscribeDocCallback();
        shareDoc.unsubscribe(unsubscribeDocCallback);
      }
    }
    function unsubscribeDocCallback(err?) {
      model._maybeUnloadDoc(collectionName, id);
      if (err) return cb(err);
      cb(null, 0);
    }
  }

  // Removes the document from the local model if the model no longer has any
  // remaining fetches or subscribes via a query or direct loading
  _maybeUnloadDoc(collectionName: string, id: string) {
    const doc = this.getDoc(collectionName, id);
    if (!doc) return;

    if (this._hasDocReferences(collectionName, id)) return;

    const previous = doc.get();

    // Remove doc from Racer
    this.root.collections[collectionName].remove(id);
    // Remove doc from Share
    if (doc.shareDoc) doc.shareDoc.destroy();

    this.emit('unload', [collectionName, id], [previous, this._pass]);
  }

  _hasDocReferences(collectionName: string, id: string) {
    // Check if any fetched or subscribed queries currently have the
    // id in their results
    const queries = this.root._queries.collections[collectionName];
    if (queries) {
      for (const hash in queries) {
        const query = queries[hash];
        if (!query.subscribeCount && !query.fetchCount) continue;
        if (query.idMap[id]) return true;
      }
    }

    // Check if document currently has direct fetch or subscribe
    if (
      this.root._fetchedDocs.get(collectionName, id) ||
      this.root._subscribedDocs.get(collectionName, id)
    ) return true;

    return false;
  }

  /** //////////////////////
  // unbundle
  //////////////////////*/

  unbundle(data) {
    if (this.connection) this.connection.startBulk();

    // Re-create and subscribe queries; re-create documents associated with queries
    this._initQueries(data.queries);

    // Re-create other documents
    for (var collectionName in data.collections) {
      var collection = data.collections[collectionName];
      for (var id in collection) {
        this.getOrCreateDoc(collectionName, id, collection[id]);
      }
    }

    for (const contextId in data.contexts) {
      const contextData = data.contexts[contextId];
      const contextModel = this.context(contextId);
      // Re-init fetchedDocs counts
      for (var collectionName in contextData.fetchedDocs) {
        var collection = contextData.fetchedDocs[collectionName];
        for (var id in collection) {
          var count = collection[id];
          while (count--) {
            contextModel._context.fetchDoc(collectionName, id);
            this._fetchedDocs.increment(collectionName, id);
          }
        }
      }
      // Subscribe to document subscriptions
      for (var collectionName in contextData.subscribedDocs) {
        var collection = contextData.subscribedDocs[collectionName];
        for (var id in collection) {
          var count = collection[id];
          while (count--) {
            contextModel.subscribeDoc(collectionName, id);
          }
        }
      }
      // Re-init createdDocs counts
      for (var collectionName in contextData.createdDocs) {
        var collection = contextData.createdDocs[collectionName];
        for (var id in collection) {
          // Count value doesn't matter for tracking creates
          contextModel._context.createDoc(collectionName, id);
        }
      }
    }

    if (this.connection) this.connection.endBulk();

    // Re-create refs
    for (var i = 0; i < data.refs.length; i++) {
      var item = data.refs[i];
      this.ref(item[0], item[1]);
    }
    // Re-create refLists
    for (var i = 0; i < data.refLists.length; i++) {
      var item = data.refLists[i];
      this.refList(item[0], item[1], item[2], item[3]);
    }
    // Re-create fns
    for (var i = 0; i < data.fns.length; i++) {
      var item = data.fns[i];
      this.start.apply(this, item);
    }
    // Re-create filters
    for (var i = 0; i < data.filters.length; i++) {
      var item = data.filters[i];
      const filter = this._filters.add(item[1], item[2], item[3], item[4], item[5]);
      filter.ref(item[0]);
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
    this._context = model._context;
    this._at = model._at;
    this._pass = model._pass;
    this._silent = model._silent;
    this._eventContext = model._eventContext;
    this._preventCompose = model._preventCompose;
  }
}




// ** bundle

function stripComputed(root: Model) {
  const silentModel = root.silent();
  const refListsMap = root._refLists.fromMap;
  const fnsMap = root._fns.fromMap;
  for (var from in refListsMap) {
    silentModel._del(refListsMap[from].fromSegments);
  }
  for (var from in fnsMap) {
    silentModel._del(fnsMap[from].fromSegments);
  }
  silentModel.removeAllFilters();
  silentModel.destroy('$queries');
}

function serializeCollections(root: Model) {
  const out = {};
  for (const collectionName in root.collections) {
    const collection = root.collections[collectionName];
    out[collectionName] = {};
    for (const id in collection.docs) {
      const doc = collection.docs[id];
      const shareDoc = doc.shareDoc;
      let snapshot;
      if (shareDoc) {
        snapshot = {
          v: shareDoc.version,
          data: shareDoc.data
        };
        if (shareDoc.type !== defaultType) {
          snapshot.type = doc.shareDoc.type && doc.shareDoc.type.name;
        }
      } else {
        snapshot = doc.data;
      }
      out[collectionName][id] = snapshot;
    }
  }
  return out;
}

function errorOnCommit() {
  this.emit('error', new Error('Model mutation performed after bundling'));
}

// ** events

export function Passed(previous, value) {
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


// ** filter

function parseFilterArguments(model: Model, args: any[]) {
  const fn = args.pop();
  let options;
  if (!model.isPath(args[args.length - 1])) {
    options = args.pop();
  }
  const path = model.path(args.shift());
  let i = args.length;
  while (i--) {
    args[i] = model.path(args[i]);
  }
  return {
    path: path,
    inputPaths: (args.length) ? args : null,
    options: options,
    fn: fn
  };
}


// ** fn

function parseStartArguments(model: Model, args: any[], hasPath: boolean) {
  const last = args.pop();
  let fns, name;
  if (typeof last === 'string') {
    name = last;
  } else {
    fns = last;
  }
  let path;
  if (hasPath) {
    path = model.path(args.shift());
  }
  let options;
  if (!model.isPath(args[args.length - 1])) {
    options = args.pop();
  }
  let i = args.length;
  while (i--) {
    args[i] = model.path(args[i]);
  }
  return {
    name: name,
    path: path,
    inputPaths: args,
    fns: fns,
    options: options
  };
}


// ** ref

/* This adds listeners to the {insert,move,remove}Immediate events.
 *
 * model is the root model.
 */
function addIndexListeners(model: Model) {
  model.on('insertImmediate', function refInsertIndex(segments: string[], eventArgs: any[]) {
    const index = eventArgs[0];
    const howMany = eventArgs[1].length;
    function patchInsert(refIndex: number) {
      return (index <= refIndex) ? refIndex + howMany : refIndex;
    }
    onIndexChange(segments, patchInsert);
  });
  model.on('removeImmediate', function refRemoveIndex(segments: string[], eventArgs: any[]) {
    const index = eventArgs[0];
    const howMany = eventArgs[1].length;
    function patchRemove(refIndex: number) {
      return (index <= refIndex) ? refIndex - howMany : refIndex;
    }
    onIndexChange(segments, patchRemove);
  });
  model.on('moveImmediate', function refMoveIndex(segments: string[], eventArgs: any[]) {
    const from = eventArgs[0];
    const to = eventArgs[1];
    const howMany = eventArgs[2];
    function patchMove(refIndex: number) {
      // If the index was moved itself
      if (from <= refIndex && refIndex < from + howMany) {
        return refIndex + to - from;
      }
      // Remove part of a move
      if (from <= refIndex) refIndex -= howMany;
      // Insert part of a move
      if (to <= refIndex) refIndex += howMany;
      return refIndex;
    }
    onIndexChange(segments, patchMove);
  });
  function onIndexChange(segments: string[], patch: (refIndex: number) => number): void {
    const toPathMap = model._refs.toPathMap;
    const refs = toPathMap.get(segments) || [];
    console.log('onIndexChange - segments: ', segments, 'refs: ', refs);

    for (let i = 0, len = refs.length; i < len; i++) {
      const ref = refs[i];
      const from = ref.from;
      if (!(ref.updateIndices &&
        ref.toSegments.length > segments.length)) continue;
      const index = +ref.toSegments[segments.length];
      const patched = patch(index);
      if (index === patched) continue;
      model._refs.remove(from);
      ref.toSegments[segments.length] = '' + patched;
      ref.to = ref.toSegments.join('.');
      model._refs.add(ref);
    }
  }
}

function refChange(model: Model, dereferenced, eventArgs: any[], segments: string[]) {
  const value = eventArgs[0];
  // Detect if we are deleting vs. setting to undefined
  if (value === undefined) {
    const parentSegments = segments.slice();
    const last = parentSegments.pop();
    const parent = model._get(parentSegments);
    if (!parent || !(last in parent)) {
      model._del(dereferenced);
      return;
    }
  }
  model._set(dereferenced, value);
}
function refLoad(model, dereferenced, eventArgs) {
  const value = eventArgs[0];
  model._set(dereferenced, value);
}
function refUnload(model, dereferenced) {
  model._del(dereferenced);
}
function refInsert(model, dereferenced, eventArgs) {
  const index = eventArgs[0];
  const values = eventArgs[1];
  model._insert(dereferenced, index, values);
}
function refRemove(model, dereferenced, eventArgs) {
  const index = eventArgs[0];
  const howMany = eventArgs[1].length;
  model._remove(dereferenced, index, howMany);
}
function refMove(model, dereferenced, eventArgs) {
  const from = eventArgs[0];
  const to = eventArgs[1];
  const howMany = eventArgs[2];
  model._move(dereferenced, from, to, howMany);
}

function addListener(model: Model, type: string, fn): void {
  model.on(type + 'Immediate', refListener);
  function refListener(segments: string[], eventArgs: any[]) {
    const pass = eventArgs[eventArgs.length - 1];
    // Find cases where an event is emitted on a path where a reference
    // is pointing. All original mutations happen on the fully dereferenced
    // location, so this detection only needs to happen in one direction
    const toPathMap = model._refs.toPathMap;
    let subpath;
    for (let i = 0, len = segments.length; i < len; i++) {
      subpath = (subpath) ? subpath + '.' + segments[i] : segments[i];
      // If a ref is found pointing to a matching subpath, re-emit on the
      // place where the reference is coming from as if the mutation also
      // occured at that path
      var refs = toPathMap.get(subpath.split('.'), true);
      if (!refs.length) continue;
      const remaining = segments.slice(i + 1);
      for (var refIndex = 0, numRefs = refs.length; refIndex < numRefs; refIndex++) {
        var ref = refs[refIndex];
        const dereferenced = ref.fromSegments.concat(remaining);
        // The value may already be up to date via object reference. If so,
        // simply re-emit the event. Otherwise, perform the same mutation on
        // the ref's path
        if (model._get(dereferenced) === model._get(segments)) {
          model.emit(type, dereferenced, eventArgs);
        } else {
          var setterModel = ref.model.pass(pass, true);
          setterModel._dereference = noopDereference;
          fn(setterModel, dereferenced, eventArgs, segments);
        }
      }
    }
    // If a ref points to a child of a matching subpath, get the value in
    // case it has changed and set if different
    const parentToPathMap = model._refs.parentToPathMap;
    var refs = parentToPathMap.get(subpath.split('.'), true);
    if (!refs.length) return;
    for (var refIndex = 0, numRefs = refs.length; refIndex < numRefs; refIndex++) {
      var ref = refs[refIndex];
      const value = model._get(ref.toSegments);
      const previous = model._get(ref.fromSegments);
      if (previous !== value) {
        var setterModel = ref.model.pass(pass, true);
        setterModel._dereference = noopDereference;
        setterModel._set(ref.fromSegments, value);
      }
    }
  }
}

function noopDereference(segments) {
  return segments;
}



// ** refList

function addRefListListener(model: Model, type: string) {
  model.on(type + 'Immediate', refListListener);
  function refListListener(segments: string[], eventArgs: any[]) {
    const pass = eventArgs[eventArgs.length - 1];
    // Check for updates on or underneath paths
    const fromMap = model._refLists.fromMap;
    for (const from in fromMap) {
      const refList = fromMap[from];
      if (pass.$refList === refList) continue;
      refList.onMutation(type, segments, eventArgs);
    }
  }
}


// ** setDiff

function diffDeep(model: Model, segments: string[], before, after, group: () => (err?: any) => void) {
  if (typeof before !== 'object' || !before ||
      typeof after !== 'object' || !after) {
    // Set the entire value if not diffable
    model._set(segments, after, group());
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const diff = arrayDiff(before, after, util.deepEqual);
    if (!diff.length) return;
    // If the only change is a single item replacement, diff the item instead
    if (
      diff.length === 2 &&
      diff[0].index === diff[1].index &&
      diff[0] instanceof arrayDiff.RemoveDiff &&
      diff[0].howMany === 1 &&
      diff[1] instanceof arrayDiff.InsertDiff &&
      diff[1].values.length === 1
    ) {
      const index = diff[0].index;
      var itemSegments = segments.concat(index);
      diffDeep(model, itemSegments, before[index], after[index], group);
      return;
    }
    model._applyArrayDiff(segments, diff, group());
    return;
  }

  // Delete keys that were in before but not after
  for (var key in before) {
    if (key in after) continue;
    var itemSegments = segments.concat(key);
    model._del(itemSegments, group());
  }

  // Diff each property in after
  for (var key in after) {
    if (util.deepEqual(before[key], after[key])) continue;
    var itemSegments = segments.concat(key);
    diffDeep(model, itemSegments, before[key], after[key], group);
  }
}
