import util from '../util';
import Model from './Model';
import Query from './Query';
import CollectionCounter from './CollectionCounter';

Model.INITS.push((model: Model, options) => {
  model.root.fetchOnly = options.fetchOnly;
  model.root.unloadDelay = options.unloadDelay || (util.isServer) ? 0 : 1000;

  // Track the total number of active fetches per doc
  model.root._fetchedDocs = new CollectionCounter();
  // Track the total number of active susbscribes per doc
  model.root._subscribedDocs = new CollectionCounter();
});

Model.prototype.fetch = function() {
  this._forSubscribable(arguments, 'fetch');
  return this;
};
Model.prototype.unfetch = function() {
  this._forSubscribable(arguments, 'unfetch');
  return this;
};
Model.prototype.subscribe = function() {
  this._forSubscribable(arguments, 'subscribe');
  return this;
};
Model.prototype.unsubscribe = function() {
  this._forSubscribable(arguments, 'unsubscribe');
  return this;
};

Model.prototype._forSubscribable = function(argumentsObject, method) {
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
};

Model.prototype.fetchDoc = function(collectionName, id, cb) {
  cb = this.wrapCallback(cb);

  // Maintain a count of fetches so that we can unload the document
  // when there are no remaining fetches or subscribes for that document
  this._context.fetchDoc(collectionName, id);
  this.root._fetchedDocs.increment(collectionName, id);

  // Fetch
  const doc = this.getOrCreateDoc(collectionName, id);
  doc.shareDoc.fetch(cb);
};

Model.prototype.subscribeDoc = function(collectionName, id, cb) {
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
};

Model.prototype.unfetchDoc = function(collectionName, id, cb) {
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
};

Model.prototype.unsubscribeDoc = function(collectionName, id, cb) {
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
};

// Removes the document from the local model if the model no longer has any
// remaining fetches or subscribes via a query or direct loading
Model.prototype._maybeUnloadDoc = function(collectionName, id) {
  const doc = this.getDoc(collectionName, id);
  if (!doc) return;

  if (this._hasDocReferences(collectionName, id)) return;

  const previous = doc.get();

  // Remove doc from Racer
  this.root.collections[collectionName].remove(id);
  // Remove doc from Share
  if (doc.shareDoc) doc.shareDoc.destroy();

  this.emit('unload', [collectionName, id], [previous, this._pass]);
};

Model.prototype._hasDocReferences = function(collectionName, id) {
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
};
