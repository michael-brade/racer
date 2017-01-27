import util from '../util';
import Model, { ChildModel } from './Model';
const defaultType = require('sharedb/lib/client').types.defaultType;


Model.INITS.push((model: Model) => {
  model.root._queries = new Queries();
});

Model.prototype.query = (collectionName, expression, options) => {
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
};

// This method replaces undefined in query objects with null, because
// undefined properties are removed in JSON stringify. This can be dangerous
// in queries, where presenece of a property may indicate that it should be a
// filter and absence means that all values are accepted. We aren't checking
// for cycles, which aren't allowed in JSON, so this could throw a max call
// stack error
Model.prototype.sanitizeQuery = function(expression) {
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
};

// Called during initialization of the bundle on page load.
Model.prototype._initQueries = function(items) {
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
};


export class Queries {

  // Map is a flattened map of queries by hash. Currently used in contexts
  public map: { [hash: string]: Query } = {};

  // Collections is a nested map of queries by collection then hash
  public collections: {
    [collectionName: string]: { [hash: string]: Query }
  } = { };


  add(query: Query): void {
    this.map[query.hash] = query;
    const collection = this.collections[query.collectionName] ||
      (this.collections[query.collectionName] = {});
    collection[query.hash] = query;
  }

  remove(query: Query): void {
    delete this.map[query.hash];
    const collection = this.collections[query.collectionName];
    if (!collection) return;
    delete collection[query.hash];
    // Check if the collection still has any keys
    // eslint-disable-next-line no-unused-vars
    for (const key in collection) return;
    delete this.collections[query.collectionName];
  }

  get(collectionName: string, expression, options): Query {
    const hash = queryHash(collectionName, expression, options);
    return this.map[hash];
  }

  toJSON() {
    const out = [];
    for (const hash in this.map) {
      const query = this.map[hash];
      if (query.subscribeCount || query.fetchCount) {
        out.push(query.serialize());
      }
    }
    return out;
  }
}

type IdMap = { [id: string]: boolean };

export default class Query {
  public model: Model;

  public collectionName: string;
  public hash: string;
  private segments: string[];
  public idsSegments: string[];
  private extraSegments: string[];

  private _pendingSubscribeCallbacks: string[];

  // These are used to help cleanup appropriately when calling unsubscribe and
  // unfetch. A query won't be fully cleaned up until unfetch and unsubscribe
  // are called the same number of times that fetch and subscribe were called.
  public subscribeCount: number;
  public fetchCount: number;

  private created: boolean;
  private shareQuery;

  // idMap is checked in maybeUnload to see if the query is currently holding
  // a reference to an id in its results set. This map is duplicative of the
  // actual results id list stored in the model, but we are maintaining it,
  // because otherwise maybeUnload would be looping through the entire results
  // set of each query on the same collection for every doc checked
  //
  // Map of id -> true
  public idMap: IdMap;

  private options;
  private expression;


  constructor(model: Model, collectionName: string, expression, options) {
    this.model = model.pass({$query: this});
    this.collectionName = collectionName;
    this.expression = expression;
    this.options = options;
    this.hash = queryHash(collectionName, expression, options);
    this.segments = ['$queries', this.hash];
    this.idsSegments = ['$queries', this.hash, 'ids'];
    this.extraSegments = ['$queries', this.hash, 'extra'];

    this._pendingSubscribeCallbacks = [];

    this.subscribeCount = 0;
    this.fetchCount = 0;

    this.created = false;
    this.shareQuery = null;

    this.idMap = {};
  }

  create(): void {
    this.created = true;
    this.model.root._queries.add(this);
  }

  destroy() {
    const ids = this.getIds();
    this.created = false;
    if (this.shareQuery) {
      this.shareQuery.destroy();
      this.shareQuery = null;
    }
    this.model.root._queries.remove(this);
    this.idMap = {};
    this.model._del(this.segments);
    this._maybeUnloadDocs(ids);
  }

  fetch(cb) {
    cb = this.model.wrapCallback(cb);
    this.model._context.fetchQuery(this);

    this.fetchCount++;

    if (!this.created) this.create();

    const query = this;
    function fetchCb(err, results, extra) {
      if (err) return cb(err);
      query._setExtra(extra);
      query._setResults(results);
      cb();
    }
    this.model.root.connection.createFetchQuery(
      this.collectionName,
      this.expression,
      this.options,
      fetchCb
    );
    return this;
  }

  subscribe(cb?): Query {
    cb = this.model.wrapCallback(cb);
    this.model._context.subscribeQuery(this);

    if (this.subscribeCount++) {
      const query = this;
      process.nextTick(() => {
        const data = query.model._get(query.segments);
        if (data) {
          cb();
        } else {
          query._pendingSubscribeCallbacks.push(cb);
        }
      });
      return this;
    }

    if (!this.created) this.create();

    const options = (this.options) ? util.copy(this.options) : {};
    options.results = this._getShareResults();

    // When doing server-side rendering, we actually do a fetch the first time
    // that subscribe is called, but keep track of the state as if subscribe
    // were called for proper initialization in the client
    if (this.model.root.fetchOnly) {
      this._shareFetchedSubscribe(options, cb);
    } else {
      this._shareSubscribe(options, cb);
    }

    return this;
  }

  _subscribeCb(cb) {
    const query = this;
    return function subscribeCb(err, results, extra) {
      if (err) return query._flushSubscribeCallbacks(err, cb);
      query._setExtra(extra);
      query._setResults(results);
      query._flushSubscribeCallbacks(null, cb);
    };
  }

  _shareFetchedSubscribe(options, cb) {
    this.model.root.connection.createFetchQuery(
      this.collectionName,
      this.expression,
      options,
      this._subscribeCb(cb)
    );
  }

  _shareSubscribe(options, cb) {
    const query = this;
    // Sanity check, though this shouldn't happen
    if (this.shareQuery) {
      this.shareQuery.destroy();
    }
    this.shareQuery = this.model.root.connection.createSubscribeQuery(
      this.collectionName,
      this.expression,
      options,
      this._subscribeCb(cb)
    );
    this.shareQuery.on('insert', (shareDocs, index) => {
      const ids = resultsIds(shareDocs);
      query._addMapIds(ids);
      query.model._insert(query.idsSegments, index, ids);
    });
    this.shareQuery.on('remove', (shareDocs, index) => {
      const ids = resultsIds(shareDocs);
      query._removeMapIds(ids);
      query.model._remove(query.idsSegments, index, shareDocs.length);
    });
    this.shareQuery.on('move', (shareDocs, from, to) => {
      query.model._move(query.idsSegments, from, to, shareDocs.length);
    });
    this.shareQuery.on('extra', extra => {
      query.model._setDiffDeep(query.extraSegments, extra);
    });
    this.shareQuery.on('error', err => {
      query.model._emitError(err, query.hash);
    });
  }

  _removeMapIds(ids: string[]) {
    for (let i = ids.length; i--; ) {
      const id = ids[i];
      delete this.idMap[id];
    }
    // Technically this isn't quite right and we might not wait the full unload
    // delay if someone else calls maybeUnload for the same doc id. However,
    // it is a lot easier to implement than delaying the removal until later and
    // dealing with adds that might happen in the meantime. This will probably
    // work to avoid thrashing subscribe/unsubscribe in expected cases
    if (this.model.root.unloadDelay) {
      const query = this;
      setTimeout(() => {
        query._maybeUnloadDocs(ids);
      }, this.model.root.unloadDelay);
      return;
    }
    this._maybeUnloadDocs(ids);
  }

  _addMapIds(ids: string[]): void {
    for (let i = ids.length; i--; ) {
      const id = ids[i];
      this.idMap[id] = true;
    }
  }

  _diffMapIds(ids: string[]): void {
    const addedIds: string[] = [];
    const removedIds: string[] = [];
    const newMap: IdMap = {};
    for (let i: number = ids.length; i--; ) {
      let id = ids[i];
      newMap[id] = true;
      if (this.idMap[id]) continue;
      addedIds.push(id);
    }
    for (let id in this.idMap) {
      if (newMap[id]) continue;
      removedIds.push(id);
    }
    if (addedIds.length) this._addMapIds(addedIds);
    if (removedIds.length) this._removeMapIds(removedIds);
  }

  _setExtra(extra): void {
    if (extra === undefined) return;
    this.model._setDiffDeep(this.extraSegments, extra);
  }

  _setResults(results): void {
    const ids = resultsIds(results);
    this._setResultIds(ids);
  }

  _setResultIds(ids: string[]): void {
    this._diffMapIds(ids);
    this.model._setArrayDiff(this.idsSegments, ids);
  }

  _maybeUnloadDocs(ids: string[]): void {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.model._maybeUnloadDoc(this.collectionName, id);
    }
  }

  // Flushes `_pendingSubscribeCallbacks`, calling each callback in the array,
  // with an optional error to pass into each. `_pendingSubscribeCallbacks` will
  // be empty after this runs.
  _flushSubscribeCallbacks(err, cb): void {
    cb(err);
    let pendingCallback;
    while ((pendingCallback = this._pendingSubscribeCallbacks.shift())) {
      pendingCallback(err);
    }
  }

  unfetch(cb?): Query {
    cb = this.model.wrapCallback(cb);
    this.model._context.unfetchQuery(this);

    // No effect if the query is not currently fetched
    if (!this.fetchCount) {
      cb();
      return this;
    }

    const query = this;
    if (this.model.root.unloadDelay) {
      setTimeout(finishUnfetchQuery, this.model.root.unloadDelay);
    } else {
      finishUnfetchQuery();
    }
    function finishUnfetchQuery() {
      const count = --query.fetchCount;
      if (count) return cb(null, count);
      // Cleanup when no fetches or subscribes remain
      if (!query.subscribeCount) query.destroy();
      cb(null, 0);
    }
    return this;
  }

  unsubscribe(cb?): Query {
    cb = this.model.wrapCallback(cb);
    this.model._context.unsubscribeQuery(this);

    // No effect if the query is not currently subscribed
    if (!this.subscribeCount) {
      cb();
      return this;
    }

    const query = this;
    if (this.model.root.unloadDelay) {
      setTimeout(finishUnsubscribeQuery, this.model.root.unloadDelay);
    } else {
      finishUnsubscribeQuery();
    }
    function finishUnsubscribeQuery() {
      const count = --query.subscribeCount;
      if (count) return cb(null, count);

      if (query.shareQuery) {
        query.shareQuery.destroy();
        query.shareQuery = null;
      }

      unsubscribeQueryCallback();
    }
    function unsubscribeQueryCallback(err?) {
      if (err) return cb(err);
      // Cleanup when no fetches or subscribes remain
      if (!query.fetchCount) query.destroy();
      cb(null, 0);
    }
    return this;
  }

  // return an array of shareDocs
  _getShareResults(): any[] {
    const ids = this.model._get(this.idsSegments);
    if (!ids) return;

    const collection = this.model.getCollection(this.collectionName);
    if (!collection) return;

    const results = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const doc = collection.docs[id];
      results.push(doc && doc.shareDoc);
    }
    return results;
  }

  get() {
    const results = [];
    const data = this.model._get(this.segments);
    if (!data) {
      console.warn('You must fetch or subscribe to a query before getting its results.');
      return results;
    }
    const ids = data.ids;
    if (!ids) return results;

    const collection = this.model.getCollection(this.collectionName);
    for (let i = 0, l = ids.length; i < l; i++) {
      const id = ids[i];
      const doc = collection && collection.docs[id];
      results.push(doc && doc.get());
    }
    return results;
  }

  getIds() {
    return this.model._get(this.idsSegments) || [];
  }

  getExtra() {
    return this.model._get(this.extraSegments);
  }

  ref(from: string): ChildModel {
    const idsPath = this.idsSegments.join('.');
    return this.model.refList(from, this.collectionName, idsPath);
  }

  refIds(from: string): ChildModel {
    const idsPath = this.idsSegments.join('.');
    return this.model.root.ref(from, idsPath);
  }

  refExtra(from: string, relPath: string): ChildModel {
    let extraPath = this.extraSegments.join('.');
    if (relPath) extraPath += '.' + relPath;
    return this.model.root.ref(from, extraPath);
  }

  serialize() {
    const ids = this.getIds();
    const collection = this.model.getCollection(this.collectionName);
    let results;
    if (collection) {
      results = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const doc = collection.docs[id];    // TODO: RemoteDoc!
        if (doc) {
          delete collection.docs[id];
          const data = doc.shareDoc.data;
          const result = [data, doc.shareDoc.version];
          if (!data || data.id !== id) {
            result[2] = id;
          }
          if (doc.shareDoc.type !== defaultType) {
            result[3] = doc.shareDoc.type && doc.shareDoc.type.name;
          }
          results.push(result);
        } else {
          results.push(id);
        }
      }
    }
    const counts = [];
    const contexts = this.model.root._contexts;
    for (const key in contexts) {
      const context = contexts[key];
      const subscribed = context.subscribedQueries[this.hash] || 0;
      const fetched = context.fetchedQueries[this.hash] || 0;
      if (subscribed || fetched) {
        if (key !== 'root') {
          counts.push([subscribed, fetched, key]);
        } else if (fetched) {
          counts.push([subscribed, fetched]);
        } else {
          counts.push([subscribed]);
        }
      }
    }
    const serialized = [
      counts,
      this.collectionName,
      this.expression,
      results,
      this.options,
      this.getExtra()
    ];
    while (serialized[serialized.length - 1] == null) {
      serialized.pop();
    }
    return serialized;
  }
}

function queryHash(collectionName: string, expression, options): string {
  const args = [collectionName, expression, options];
  return JSON.stringify(args).replace(/\./g, '|');
}

// TODO: results has shareDocs! with id, not just any!
function resultsIds(results: any[]): string[] {
  const ids = [];
  for (let i = 0; i < results.length; i++) {
    const shareDoc = results[i];
    ids.push(shareDoc.id);
  }
  return ids;
}
