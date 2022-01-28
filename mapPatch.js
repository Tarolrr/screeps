Map.fromObject = (obj) => new Map(Object.keys(obj).map(k => [k, obj[k]]))
Map.toObject = function() {
    result = {}
    this.forEach((v, k) => result[k] = v)
    return result
}
Map.filter = function(predicate) {
    return new Map(Array.from(this).filter(predicate))
}