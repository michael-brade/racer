import Model from './Model';
import { Doc } from './Doc';


export class CollectionMap {
  [name: string]: Collection;
}

export class DocMap {
  [name: string]: Doc;
}

export class ModelData {}
export class CollectionData {}



export class Collection {
  private model: Model;
  private name: string;
  private Doc: { new(model: Model, collectionName: string, id: string, data, collection: Collection): Doc };
  public docs: DocMap;
  private data: CollectionData;


  // TODO: how to pass Doc CTOR here? The class, not the instance?
  constructor(model: Model, name: string, Doc) {
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
  add(id: string, data: Object) {
    const doc = new this.Doc(this.model, this.name, id, data, this);
    this.docs[id] = doc;
    return doc;
  }

  destroy(): void {
    delete this.model.collections[this.name];
    delete this.model.data[this.name];
  }

  /**
   * Removes the document with `id` from `this` Collection. If there are no more
   * documents in the Collection after the given document is removed, then this
   * also destroys the Collection.
   * @param {String} id
   */
  remove(id: string) {
    delete this.docs[id];
    delete this.data[id];
    if (noKeys(this.docs)) this.destroy();
  }

  /**
   * Returns an object that maps doc ids to fully resolved documents.
   * @return {Object}
   */
  get(): CollectionData {
    return this.data;
  }
}

function noKeys(object): boolean {
  // eslint-disable-next-line no-unused-vars
  for (const key in object) {
    return false;
  }
  return true;
}
