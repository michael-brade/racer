/**
 * Contexts are useful for keeping track of the origin of subscribes.
 */
import Model from './Model';
import CollectionCounter from './CollectionCounter';


Model.INITS.push(model => {
  model.root._contexts = new Contexts();
  model.root.setContext('root');
});

Model.prototype.context = function(id) {
  const model = this._child();
  model.setContext(id);
  return model;
};

Model.prototype.setContext = function(id) {
  this._context = this.getOrCreateContext(id);
};

Model.prototype.getOrCreateContext = function(id) {
  const context = this.root._contexts[id] ||
    (this.root._contexts[id] = new Context(this, id));
  return context;
};

Model.prototype.unload = function(id) {
  const context = (id) ? this.root._contexts[id] : this._context;
  context && context.unload();
};

Model.prototype.unloadAll = function() {
  const contexts = this.root._contexts;
  for (const key in contexts) {
    contexts[key].unload();
  }
};

class Contexts {}

class FetchedQueries {}
class SubscribedQueries {}


class Context {
  private model: Model;
  private id; // TODO

  private fetchedDocs: CollectionCounter;
  private subscribedDocs: CollectionCounter;
  private createdDocs: CollectionCounter;

  private fetchedQueries: FetchedQueries;
  private subscribedQueries: SubscribedQueries;


  constructor(model, id) {
    this.model = model;
    this.id = id;
    this.fetchedDocs = new CollectionCounter();
    this.subscribedDocs = new CollectionCounter();
    this.createdDocs = new CollectionCounter();
    this.fetchedQueries = new FetchedQueries();
    this.subscribedQueries = new SubscribedQueries();
  }

  toJSON() {
    const fetchedDocs = this.fetchedDocs.toJSON();
    const subscribedDocs = this.subscribedDocs.toJSON();
    const createdDocs = this.createdDocs.toJSON();
    if (!fetchedDocs && !subscribedDocs && !createdDocs) return;
    return {
      fetchedDocs: fetchedDocs,
      subscribedDocs: subscribedDocs,
      createdDocs: createdDocs
    };
  }

  fetchDoc(collectionName, id) {
    this.fetchedDocs.increment(collectionName, id);
  }

  subscribeDoc(collectionName, id) {
    this.subscribedDocs.increment(collectionName, id);
  }

  unfetchDoc(collectionName, id) {
    this.fetchedDocs.decrement(collectionName, id);
  }

  unsubscribeDoc(collectionName, id) {
    this.subscribedDocs.decrement(collectionName, id);
  }

  createDoc(collectionName, id) {
    this.createdDocs.increment(collectionName, id);
  }

  fetchQuery(query) {
    mapIncrement(this.fetchedQueries, query.hash);
  }

  subscribeQuery(query) {
    mapIncrement(this.subscribedQueries, query.hash);
  }

  unfetchQuery(query) {
    mapDecrement(this.fetchedQueries, query.hash);
  }

  unsubscribeQuery(query) {
    mapDecrement(this.subscribedQueries, query.hash);
  }

  unload() {
    const model = this.model;
    for (let hash in this.fetchedQueries) {
      let query = model.root._queries.map[hash];
      if (!query) continue;
      let count = this.fetchedQueries[hash];
      while (count--) query.unfetch();
    }
    for (let hash in this.subscribedQueries) {
      let query = model.root._queries.map[hash];
      if (!query) continue;
      let count = this.subscribedQueries[hash];
      while (count--) query.unsubscribe();
    }
    for (let collectionName in this.fetchedDocs.collections) {
      let collection = this.fetchedDocs.collections[collectionName];
      for (let id in collection) {
        let count = collection[id];
        while (count--) model.unfetchDoc(collectionName, id);
      }
    }
    for (let collectionName in this.subscribedDocs.collections) {
      let collection = this.subscribedDocs.collections[collectionName];
      for (let id in collection) {
        let count = collection[id];
        while (count--) model.unsubscribeDoc(collectionName, id);
      }
    }
    for (let collectionName in this.createdDocs.collections) {
      let collection = this.createdDocs.collections[collectionName];
      for (let id in collection) {
        model._maybeUnloadDoc(collectionName, id);
      }
    }
    this.createdDocs.reset();
  }
}

function mapIncrement(map, key) {
  map[key] = (map[key] || 0) + 1;
}
function mapDecrement(map, key) {
  map[key] && map[key]--;
  if (!map[key]) delete map[key];
}
