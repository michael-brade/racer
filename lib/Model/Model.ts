import uuid from 'uuid';


export default Model;

interface Model {

  root: Model;

  debug: {
    remoteMutations: boolean,
    disableSubmit: boolean
  };
}


class Model {
  public static INITS = [];
  public static ChildModel = ChildModel;

  constructor(options) {
    this.root = this;

    const inits = Model.INITS;
    if (!options) options = {};
    this.debug = options.debug || {};
    for (let i = 0; i < inits.length; i++) {
      inits[i](this, options);
    }
  }

  id() {
    return uuid.v4();
  }

  _child() {
    return new ChildModel(this);
  }
  
}


class ChildModel extends Model {
  constructor(model) {
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
