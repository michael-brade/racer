// import { ModelClientServer as Model } from './ModelClientServer';
import { Options }            from './Model';
import { ModelClientServer }  from './ModelClientServer';
import ModelStandalone        from './ModelStandalone';

import { Connection }         from 'sharedb/lib/client';

import CollectionCounter      from './CollectionCounter';

import { Contexts, Context }  from './contexts';

import Query, { Queries }     from './Query';

import { Doc }                from './Doc';
import LocalDoc               from './LocalDoc';
import RemoteDoc              from './RemoteDoc';

import util             from '../util';


export default class ModelClient extends ModelStandalone implements ModelClientServer {
  public static ChildModel = ChildModel;

  root: ModelClientServer;

  // connection
  _preventCompose: boolean = false;
  connection;
  socket;
  _createSocket: (bundle) => any;  // Model::_createSocket should be defined by the socket plugin

  // subscriptions
  fetchOnly: boolean;
  unloadDelay: number;
  _fetchedDocs: CollectionCounter;
  _subscribedDocs: CollectionCounter;

  // Query
  _queries: Queries;

  // contexts
  _contexts: Contexts;
  _context: Context;


  constructor(options: Options = {}) {
    super();
    const root = this.root = this;

    ///////////////////////
    // connection
    ///////////////////////

    root._preventCompose = false;


    ///////////////////////
    // subscriptions
    ///////////////////////

    root.fetchOnly = options.fetchOnly;
    root.unloadDelay = options.unloadDelay || (util.isServer) ? 0 : 1000;

    // Track the total number of active fetches per doc
    root._fetchedDocs = new CollectionCounter();
    // Track the total number of active susbscribes per doc
    root._subscribedDocs = new CollectionCounter();


    ///////////////////////
    // Query
    ///////////////////////

    root._queries = new Queries();


    ///////////////////////
    // contexts
    ///////////////////////

    root._contexts = new Contexts();
    root.setContext('root');
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

  // overwrite ModelStandalone
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

  createConnection(bundle, dummy): void {
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

  _getDocConstructor(name: string): { new(model: ModelClientServer, collectionName: string, id: string, data, collection): Doc } {
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
}


class ChildModel extends ModelClient implements ModelClientServer {

  constructor(model: ModelClient) {
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


