import { EventEmitter } from 'events';
import uuid from 'uuid';

import Query from './Query';

export default Model;


interface Options {
  debug?: DebugOptions;
}

interface DebugOptions {
  remoteMutations?: boolean;
  disableSubmit?: boolean;
}


interface Model {
  root: Model;
  data: string;

  debug: DebugOptions;

  // public
  query(collectionName: string, expression, options): Query;
  sanitizeQuery(expression);


  // private stuff
  _events;
  _maxListeners;

  _context;
  _at;
  _pass;
  _silent;
  _eventContext;
  _preventCompose;
}


class Model extends EventEmitter {
  public static INITS = [];
  public static ChildModel = ChildModel;

  constructor(options: Options = {}) {
    super();
    this.root = this;

    const inits = Model.INITS;
    this.debug = options.debug || {};
    for (let i = 0; i < inits.length; i++) {
      inits[i](this, options);
    }
  }

  id() {
    return uuid.v4();
  }

  _child(): ChildModel {
    return new ChildModel(this);
  }
}


export class ChildModel extends Model {

  constructor(model: Model) {
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
