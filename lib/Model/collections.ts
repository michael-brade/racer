import Model from './Model';
import Doc from './Doc';
import LocalDoc from './LocalDoc';

import util from '../util';


export class CollectionMap {}
export class ModelData {}
export class DocMap {}
export class CollectionData {}

Model.INITS.push(model => {
  model.root.collections = new CollectionMap();
  model.root.data = new ModelData();
});

Model.prototype.getCollection = function(collectionName) {
  return this.root.collections[collectionName];
};
Model.prototype.getDoc = function(collectionName, id) {
  const collection = this.root.collections[collectionName];
  return collection && collection.docs[id];
};
Model.prototype.get = function(subpath) {
  const segments = this._splitPath(subpath);
  return this._get(segments);
};
Model.prototype._get = function(segments) {
  return util.lookup(segments, this.root.data);
};
Model.prototype.getCopy = function(subpath) {
  const segments = this._splitPath(subpath);
  return this._getCopy(segments);
};
Model.prototype._getCopy = function(segments) {
  const value = this._get(segments);
  return util.copy(value);
};
Model.prototype.getDeepCopy = function(subpath) {
  const segments = this._splitPath(subpath);
  return this._getDeepCopy(segments);
};
Model.prototype._getDeepCopy = function(segments) {
  const value = this._get(segments);
  return util.deepCopy(value);
};
Model.prototype.getOrCreateCollection = function(name) {
  let collection = this.root.collections[name];
  if (collection) return collection;
  const Doc = this._getDocConstructor(name);
  collection = new Collection(this.root, name, Doc);
  this.root.collections[name] = collection;
  return collection;
};
Model.prototype._getDocConstructor = function() {
  // Only create local documents. This is overriden in ./connection.js, so that
// the RemoteDoc behavior can be selectively included
  return LocalDoc;
};

/**
 * Returns an existing document with id in a collection. If the document does
 * not exist, then creates the document with id in a collection and returns the
 * new document.
 * @param {String} collectionName
 * @param {String} id
 * @param {Object} [data] data to create if doc with id does not exist in collection
 */
Model.prototype.getOrCreateDoc = function(collectionName, id, data) {
  const collection = this.getOrCreateCollection(collectionName);
  return collection.docs[id] || collection.add(id, data);
};

/**
 * @param {String} subpath
 */
Model.prototype.destroy = function(subpath) {
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
};

export class Collection {
  private model: Model;
  private name: string;
  private Doc: Doc;
  private docs: DocMap;
  private data: CollectionData;


  constructor(model, name, Doc) {
    this.model = model;
    this.name = name;
    this.Doc = Doc;
    this.docs = new DocMap();
    this.data = model.data[name] = new CollectionData();
  }

  /**
   * Adds a document with `id` and `data` to `this` Collection.
   * @param {String} id
   * @param {Object} data
   * @return {LocalDoc|RemoteDoc} doc
   */
  add(id, data) {
    const doc = new this.Doc(this.model, this.name, id, data, this);
    this.docs[id] = doc;
    return doc;
  }

  destroy() {
    delete this.model.collections[this.name];
    delete this.model.data[this.name];
  }

  /**
   * Removes the document with `id` from `this` Collection. If there are no more
   * documents in the Collection after the given document is removed, then this
   * also destroys the Collection.
   * @param {String} id
   */
  remove(id) {
    delete this.docs[id];
    delete this.data[id];
    if (noKeys(this.docs)) this.destroy();
  }

  /**
   * Returns an object that maps doc ids to fully resolved documents.
   * @return {Object}
   */
  get() {
    return this.data;
  }
}

function noKeys(object) {
  // eslint-disable-next-line no-unused-vars
  for (const key in object) {
    return false;
  }
  return true;
}
