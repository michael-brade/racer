/**
 * Contexts are useful for keeping track of the origin of subscribes.
 */
import Model from './Model';
import { ChildModel } from './Model';
import CollectionCounter from './CollectionCounter';
import Query from './Query';


Model.INITS.push((model: Model) => {
  model.root._contexts = new Contexts();
  model.root.setContext('root');
});

Model.prototype.context = function(id): ChildModel {
  const model = this._child();
  model.setContext(id);
  return model;
};

Model.prototype.setContext = function(id: string): void {
  this._context = this.getOrCreateContext(id);
};

Model.prototype.getOrCreateContext = function(id: string) {
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

export class Contexts {
  [id: string]: Context;
}

export class FetchedQueries {
   [key: string]: number;
}
export class SubscribedQueries {
   [key: string]: number;
}


export class Context {
  private model: Model;
  private id: string; // 'root', or.... TODO

  private fetchedDocs: CollectionCounter;
  private subscribedDocs: CollectionCounter;
  private createdDocs: CollectionCounter;

  public fetchedQueries: FetchedQueries;
  public subscribedQueries: SubscribedQueries;


  constructor(model: Model, id: string) {
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

  fetchDoc(collectionName: string, id: string) {
    this.fetchedDocs.increment(collectionName, id);
  }

  subscribeDoc(collectionName: string, id: string) {
    this.subscribedDocs.increment(collectionName, id);
  }

  unfetchDoc(collectionName: string, id: string) {
    this.fetchedDocs.decrement(collectionName, id);
  }

  unsubscribeDoc(collectionName: string, id: string) {
    this.subscribedDocs.decrement(collectionName, id);
  }

  createDoc(collectionName: string, id: string) {
    this.createdDocs.increment(collectionName, id);
  }

  fetchQuery(query: Query) {
    mapIncrement(this.fetchedQueries, query.hash);
  }

  subscribeQuery(query: Query) {
    mapIncrement(this.subscribedQueries, query.hash);
  }

  unfetchQuery(query: Query) {
    mapDecrement(this.fetchedQueries, query.hash);
  }

  unsubscribeQuery(query: Query) {
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

function mapIncrement(map: { [key: string]: number }, key: string) {
  map[key] = (map[key] || 0) + 1;
}
function mapDecrement(map: { [key: string]: number }, key: string) {
  map[key] && map[key]--;
  if (!map[key]) delete map[key];
}
