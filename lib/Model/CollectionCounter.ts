export default class CollectionCounter {

  constructor() {
    this.reset();
  }

  reset() {
    this.collections = {};
  }

  get(collectionName, id) {
    const collection = this.collections[collectionName];
    return collection && collection[id];
  }

  increment(collectionName, id) {
    const collection = this.collections[collectionName] ||
      (this.collections[collectionName] = {});
    const count = (collection[id] || 0) + 1;
    collection[id] = count;
    return count;
  }

  decrement(collectionName, id) {
    const collection = this.collections[collectionName];
    let count = collection && collection[id];
    if (count == null) return;
    if (count > 1) {
      count--;
      collection[id] = count;
      return count;
    }
    delete collection[id];
    // Check if the collection still has any keys
    // eslint-disable-next-line no-unused-vars
    for (const key in collection) return 0;
    delete this.collections[collection];
    return 0;
  }

  toJSON() {
    // Check to see if we have any keys
    // eslint-disable-next-line no-unused-vars
    for (const key in this.collections) {
      return this.collections;
    }
    return;
  }
}
