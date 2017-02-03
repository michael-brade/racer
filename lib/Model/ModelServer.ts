import { Options } from './Model';
import { ModelClientServer as Model } from './ModelClientServer';
import ModelClient from './ModelClient';
import { defaultType }  from 'sharedb/lib/client';




export default class ModelServer extends ModelClient implements Model {

  root: Model;

  // bundle
  public static BUNDLE_TIMEOUT = 10 * 1000;

  bundleTimeout: number;
  _commit: Function;

  constructor(options: Options = {}) {
    super(options);

    this.bundleTimeout = options.bundleTimeout || ModelServer.BUNDLE_TIMEOUT;
  }


  /** //////////////////////
  // bundle
  //////////////////////*/

  bundle(cb: any): void {
    const root: ModelServer = this.root;
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



  // connection.server

  createConnection(backend, req): void {
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


}




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
