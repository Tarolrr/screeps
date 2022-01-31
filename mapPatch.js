Map.fromObject = (obj) => new Map(Object.keys(obj).map(k => [k, obj[k]]))
Map.prototype.toObject = function() {
    result = {}
    this.forEach((v, k) => result[k] = v)
    return result
}
Map.prototype.filter = function(predicate) {
    return new Map(Array.from(this).filter(predicate))
}

Array.prototype.flat = function(depth=1) {
    return this.reduce(function (flat, toFlatten) {
        return flat.concat((Array.isArray(toFlatten) && (depth>1)) ? toFlatten.flat(depth-1) : toFlatten);
    })
}