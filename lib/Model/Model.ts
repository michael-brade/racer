import { EventEmitter } from 'events';
import uuid from 'uuid';

import { Collection, CollectionMap, ModelData } from './collections';
import { Contexts } from './contexts';
import Doc from './Doc';
import LocalDoc from './LocalDoc';
import { Filters } from './filter';
import { Fns, NamedFns } from './fn';
import Query, { Queries } from './Query';
import { Refs } from './ref';
import { RefLists } from './refList';

import util from '../util';

export default Model;

export interface Options {
  debug?: DebugOptions;
  bundleTimeout?: number;
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

  // collections
  collections: CollectionMap;
  data: ModelData;

  // filter
  _filters: Filters;

  // fn
  _namedFns: NamedFns;
  _fns: Fns;

  // Query
  _queries: Queries;

  // ref
  _refs: Refs;

  // refList
  _refLists: RefLists;

  _events;
  _maxListeners;

  _contexts: Contexts;
  _context;
  _at;
  _pass;
  _silent;
  _eventContext;
  _preventCompose;
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

// contexts
Model.INITS.push((model: Model) => {
  model.root._contexts = new Contexts();
  model.root.setContext('root');
});


class Model extends EventEmitter {
  public static INITS = [];
  public static ChildModel = ChildModel;

  public static BUNDLE_TIMEOUT = 10 * 1000;


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


  // ***************
  // bundle.js
  // ***************

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
        nodeEnv: process.env.NODE_ENV
      };
      stripComputed(root);
      bundle.collections = serializeCollections(root);
      root.emit('bundle', bundle);
      root._commit = errorOnCommit;
      cb(null, bundle);
    });
  }

  getCollection(collectionName: string) {
    return this.root.collections[collectionName];
  }

  getDoc(collectionName: string, id) {
    const collection = this.root.collections[collectionName];
    return collection && collection.docs[id];
  }

  get(subpath) {
    const segments = this._splitPath(subpath);
    return this._get(segments);
  }

  _get(segments) {
    return util.lookup(segments, this.root.data);
  }

  getCopy(subpath) {
    const segments = this._splitPath(subpath);
    return this._getCopy(segments);
  }

  _getCopy(segments) {
    const value = this._get(segments);
    return util.copy(value);
  }

  getDeepCopy(subpath) {
    const segments = this._splitPath(subpath);
    return this._getDeepCopy(segments);
  }

  _getDeepCopy(segments) {
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

  _getDocConstructor(): Doc {
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
  getOrCreateDoc(collectionName: string, id: string, data) {
    const collection = this.getOrCreateCollection(collectionName);
    return collection.docs[id] || collection.add(id, data);
  }

  /**
   * @param {String} subpath
   */
  destroy(subpath) {
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

  preventCompose() {
    const model = this._child();
    model._preventCompose = true;
    return model;
  }

  allowCompose() {
    const model = this._child();
    model._preventCompose = false;
    return model;
  }

  createConnection(bundle) {
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

  _finishCreateConnection() {
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

  connect() {
    this.root.socket.open();
  }

  disconnect() {
    this.root.socket.close();
  }

  reconnect() {
    this.disconnect();
    this.connect();
  }

  // Clean delayed disconnect
  close(cb) {
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

  _isLocal(name) {
    // Whether the collection is local or remote is determined by its name.
    // Collections starting with an underscore ('_') are for user-defined local
    // collections, those starting with a dollar sign ('$'') are for
    // framework-defined local collections, and all others are remote.
    const firstCharcter = name.charAt(0);
    return firstCharcter === '_' || firstCharcter === '$';
  }

  _getDocConstructor(name) {
    return (this._isLocal(name)) ? LocalDoc : RemoteDoc;
  }

  hasPending() {
    return this.root.connection.hasPending();
  }

  hasWritePending() {
    return this.root.connection.hasWritePending();
  }

  whenNothingPending(cb) {
    return this.root.connection.whenNothingPending(cb);
  }

  createConnection(backend, req) {
    this.root.backend = backend;
    this.root.req = req;
    this.root.connection = backend.connect(null, req);
    this.root.socket = this.root.connection.socket;
    // Pretend like we are always connected on the server for rendering purposes
    this._set(['$connection', 'state'], 'connected');
    this._finishCreateConnection();
  }

  connect() {
    this.root.backend.connect(this.root.connection, this.root.req);
    this.root.socket = this.root.connection.socket;
  }

  context(id) {
    const model = this._child();
    model.setContext(id);
    return model;
  }

  setContext(id) {
    this._context = this.getOrCreateContext(id);
  }

  getOrCreateContext(id) {
    const context = this.root._contexts[id] ||
      (this.root._contexts[id] = new Context(this, id));
    return context;
  }

  unload(id) {
    const context = (id) ? this.root._contexts[id] : this._context;
    context && context.unload();
  }

  unloadAll() {
    const contexts = this.root._contexts;
    for (const key in contexts) {
      contexts[key].unload();
    }
  }

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

  _emitError(err, context?) {
    let message = (err.message) ? err.message :
      (typeof err === 'string') ? err :
      'Unknown model error';
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

  emit(type) {
    if (type === 'error') {
      return this._emit.apply(this, arguments);
    }
    if (Model.MUTATOR_EVENTS[type]) {
      if (this._silent) return this;
      let segments = arguments[1];
      let eventArgs = arguments[2];
      this._emit(type + 'Immediate', segments, eventArgs);
      if (this.root._mutatorEventQueue) {
        this.root._mutatorEventQueue.push([type, segments, eventArgs]);
        return this;
      }
      this.root._mutatorEventQueue = [];
      this._emit(type, segments, eventArgs);
      this._emit('all', segments, [type].concat(eventArgs));
      while (this.root._mutatorEventQueue.length) {
        const queued = this.root._mutatorEventQueue.shift();
        type = queued[0];
        segments = queued[1];
        eventArgs = queued[2];
        this._emit(type, segments, eventArgs);
        this._emit('all', segments, [type].concat(eventArgs));
      }
      this.root._mutatorEventQueue = null;
      return this;
    }
    return this._emit.apply(this, arguments);
  }

  once(type, pattern, cb) {
    const listener = eventListener(this, pattern, cb);
    function g() {
      const matches = listener.apply(null, arguments);
      if (matches) this.removeListener(type, g);
    }
    this._on(type, g);
    return g;
  }

  removeAllListeners(type, subpattern) {
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
        return this._removeAllListeners();
      }
      return this._removeAllListeners(type);
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
  silent(value) {
    const model = this._child();
    model._silent = (value == null) ? true : value;
    return model;
  }

  eventContext(value) {
    const model = this._child();
    model._eventContext = value;
    return model;
  }

  removeContextListeners(value) {
    if (arguments.length === 0) {
      value = this._eventContext;
    }
    // Remove all events created within a given context
    for (const type in this._events) {
      const listeners = this.listeners(type);
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

  filter() {
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

  sort() {
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

  removeAllFilters(subpath) {
    const segments = this._splitPath(subpath);
    this._removeAllFilters(segments);
  }

  _removeAllFilters(segments) {
    const filters = this.root._filters.fromMap;
    for (const from in filters) {
      if (util.contains(segments, filters[from].fromSegments)) {
        filters[from].destroy();
      }
    }
  }

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

  stop(subpath): void {
    const path = this.path(subpath);
    this._stop(path);
  }

  _stop(fromPath): void {
    this.root._fns.stop(fromPath);
  }

  stopAll(subpath): void {
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

  _set(segments: string[], value, cb?) {
    segments = this._dereference(segments);
    const model = this;
    function set(doc, docSegments, fnCb) {
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
    function setNull(doc, docSegments, fnCb) {
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

  // TODO: need type object with an id (nullable)
  _add(segments: string[], value: Object, cb) {
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

  _increment(segments: string[], byNumber, cb) {
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

  _insert(segments: string[], index, values, cb) {
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

  _remove(segments: string[], index, howMany, cb) {
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

  _move(segments: string[], from, to, howMany, cb) {
    const forArrayMutator = true;
    segments = this._dereference(segments, forArrayMutator);
    if (howMany == null) howMany = 1;
    const model = this;
    function move(doc, docSegments, fnCb) {
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

  _subtypeSubmit(segments, subtype, subtypeOp, cb) {
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

  _splitPath(subpath) {
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
  path(subpath: string | number): string {
    if (subpath == null || subpath === '') return (this._at) ? this._at : '';
    if (typeof subpath === 'string' || typeof subpath === 'number') {
      return (this._at) ? this._at + '.' + subpath : '' + subpath;
    }
    if (typeof subpath.path === 'function') return subpath.path();
  }

  isPath(subpath): boolean {
    return this.path(subpath) != null;
  }

  scope(path): ChildModel {
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
  at(subpath) {
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
  parent(levels) {
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
  leaf(path) {
    if (!path) path = this.path();
    const i = path.lastIndexOf('.');
    return path.slice(i + 1);
  }

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

  _canRefTo(value) {
    return this.isPath(value) || (value && typeof value.ref === 'function');
  }

  ref() {
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

  removeRef(subpath) {
    const segments = this._splitPath(subpath);
    const fromPath = segments.join('.');
    this._removeRef(segments, fromPath);
  }

  _removeRef(segments, fromPath) {
    this.root._refs.remove(fromPath);
    this.root._refLists.remove(fromPath);
    this._del(segments);
  }

  removeAllRefs(subpath): void {
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

  refList() {
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

  _setArrayDiffDeep(segments, value, cb?) {
    return this._setArrayDiff(segments, value, cb, util.deepEqual);
  }

  _setArrayDiff(segments, value, cb?, _equalFn) {
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

  fetchDoc(collectionName, id, cb) {
    cb = this.wrapCallback(cb);

    // Maintain a count of fetches so that we can unload the document
    // when there are no remaining fetches or subscribes for that document
    this._context.fetchDoc(collectionName, id);
    this.root._fetchedDocs.increment(collectionName, id);

    // Fetch
    const doc = this.getOrCreateDoc(collectionName, id);
    doc.shareDoc.fetch(cb);
  }

  subscribeDoc(collectionName, id, cb) {
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

  unfetchDoc(collectionName, id, cb) {
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

  unsubscribeDoc(collectionName, id, cb) {
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
    function unsubscribeDocCallback(err) {
      model._maybeUnloadDoc(collectionName, id);
      if (err) return cb(err);
      cb(null, 0);
    }
  }

  // Removes the document from the local model if the model no longer has any
  // remaining fetches or subscribes via a query or direct loading
  _maybeUnloadDoc(collectionName, id) {
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

  _hasDocReferences(collectionName, id) {
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
