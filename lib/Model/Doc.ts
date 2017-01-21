export default class Doc {
  constructor(model, collectionName, id) {
    this.collectionName = collectionName;
    this.id = id;
    this.collectionData = model && model.data[collectionName];
  }

  path(segments) {
    let path = this.collectionName + '.' + this.id;
    if (segments && segments.lenth) path += '.' + segments.join('.');
    return path;
  }

  _errorMessage(description, segments, value) {
    return description + ' at ' + this.path(segments) + ': ' +
      JSON.stringify(value, null, 2);
  }
}
