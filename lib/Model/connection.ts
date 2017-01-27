import {Connection} from 'sharedb/lib/client';
import Model from './Model';
import LocalDoc from './LocalDoc';
import RemoteDoc from './RemoteDoc';

Model.INITS.push((model: Model) => {
  model.root._preventCompose = false;
});

Model.prototype.preventCompose = function() {
  const model = this._child();
  model._preventCompose = true;
  return model;
};

Model.prototype.allowCompose = function() {
  const model = this._child();
  model._preventCompose = false;
  return model;
};

Model.prototype.createConnection = function(bundle) {
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
};

Model.prototype._finishCreateConnection = function() {
  const model = this;
  this.root.connection.on('error', err => {
    model._emitError(err);
  });
  // Share docs can be created by queries, so we need to register them
  // with Racer as soon as they are created to capture their events
  this.root.connection.on('doc', shareDoc => {
    model.getOrCreateDoc(shareDoc.collection, shareDoc.id);
  });
};

Model.prototype.connect = function() {
  this.root.socket.open();
};
Model.prototype.disconnect = function() {
  this.root.socket.close();
};
Model.prototype.reconnect = function() {
  this.disconnect();
  this.connect();
};
// Clean delayed disconnect
Model.prototype.close = function(cb) {
  cb = this.wrapCallback(cb);
  const model = this;
  this.whenNothingPending(() => {
    model.root.socket.close();
    cb();
  });
};

// Returns a reference to the ShareDB agent if it is connected directly on the
// server. Will return null if the ShareDB connection has been disconnected or
// if we are not in the same process and we do not have a reference to the
// server-side agent object
Model.prototype.getAgent = function() {
  return this.root.connection.agent;
};

Model.prototype._isLocal = function(name) {
  // Whether the collection is local or remote is determined by its name.
  // Collections starting with an underscore ('_') are for user-defined local
  // collections, those starting with a dollar sign ('$'') are for
  // framework-defined local collections, and all others are remote.
  const firstCharcter = name.charAt(0);
  return firstCharcter === '_' || firstCharcter === '$';
};

Model.prototype._getDocConstructor = function(name) {
  return (this._isLocal(name)) ? LocalDoc : RemoteDoc;
};

Model.prototype.hasPending = function() {
  return this.root.connection.hasPending();
};
Model.prototype.hasWritePending = function() {
  return this.root.connection.hasWritePending();
};
Model.prototype.whenNothingPending = function(cb) {
  return this.root.connection.whenNothingPending(cb);
};
