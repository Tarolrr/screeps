const DeliveryManager = require("./DeliveryManager")

var roleMule = {

    /** @param {Creep} creep **/
    run: function(creep) {
        if((creep.spawning == true)){
            return
        }

        if(creep.memory.destination) {
            const destination = creep.memory.destination
            if(destination.type == "wait") {
                if(creep.pos.getRangeTo(destination.pos) > destination.range) {
                    creep.moveTo(destination.pos)
                    return
                }
                else if(destination.time > 0){
                    destination.time--
                    return
                }
                else {
                    delete creep.memory.destination
                }
            }
            else if(destination.type == "resource") {
                const objList = creep.room.lookForAt(LOOK_RESOURCES, destination.pos.x, destination.pos.y)
                if(objList.length > 0) {
                    if(creep.pos.getRangeTo(objList[0]) > 1) {
                        creep.moveTo(objList[0])
                    }
                    else {
                        creep.pickup(objList[0])
                        delete creep.memory.destination
                    }
                    return
                }
                delete creep.memory.destination
            }
            else if(destination.type == "structure") {
                if(creep.memory.state == "store") {
                    const structure = Game.getObjectById(destination.id)
                    if(creep.pos.getRangeTo(structure) <= 1) {
                        creep.transfer(structure, RESOURCE_ENERGY)
                        delete creep.memory.destination
                    }
                    else {
                        creep.moveTo(structure)
                    }
                    return
                }
            }
            else if(destination.type == "ground") {


                if(creep.memory.state == "collect") {

                    const pos = new RoomPosition(destination.pos.x, destination.pos.y, creep.room.name)
                    const objList = pos.findInRange(FIND_DROPPED_RESOURCES, destination.range)
                    let res
                    if(objList.length == 0) {
                        delete creep.memory.destination
                        return

                    }
                    else {
                        res = objList[0]
                    }

                    if(creep.pos.getRangeTo(res.pos) > 1) {
                        creep.moveTo(res.pos)
                    }
                    else {
                        creep.pickup(res)
                        delete creep.memory.destination
                    }
                    return
                }
                else {

                    const pos = new RoomPosition(destination.pos.x, destination.pos.y, creep.room.name)
                    if (creep.pos.getRangeTo(pos) > destination.range) {
                        creep.moveTo(pos)
                    } else {
                        creep.drop(RESOURCE_ENERGY)
                        delete creep.memory.destination
                    }
                    return
                }
            }
        }
        // if(creep.memory.path != undefined) {
        //     if(creep.memory.path.length == 0) {
        //         delete creep.memory.path;
        //         delete creep.memory.lastPos;
        //
        //         return
        //     }
        //
        //     if(creep.fatigue > 0){
        //         return
        //     }
        //     let path = Room.deserializePath(creep.memory.path)
        //     if((creep.memory.lastPos != undefined) && (creep.memory.lastPos.x == creep.pos.x) && (creep.memory.lastPos.y == creep.pos.y)){
        //         creep.memory.stallCtr++;
        //     }
        //     else if (creep.memory.lastPos != undefined){
        //         path.shift()
        //         creep.memory.stallCtr = 0;
        //         if (path.length == 0) {
        //             delete creep.memory.path;
        //             delete creep.memory.lastPos;
        //             return
        //         }
        //         creep.memory.path = Room.serializePath(path)
        //     }
        //     creep.memory.lastPos = creep.pos
        //     creep.move(path[0].direction)
        //
        //     if(creep.memory.stallCtr > 2) {
        //
        //         creep.memory.stallCtr = 0;
        //         if(creep.memory.retries++ > 1){
        //             delete creep.memory.path;
        //             delete creep.memory.lastPos;
        //             return
        //         }
        //         path = creep.room.findPath(creep.pos, new RoomPosition(path[path.length-1].x, path[path.length-1].y, creep.room.name))
        //         creep.memory.path = Room.serializePath(path)
        //     }
        //     return
        // }

        collect: if(creep.memory.state == "collect") {
            if(creep.store.getFreeCapacity() == 0) {
                // if(creep.room.memory.queue.length > 0) {
                //     creep.memory.dst = "spawn"
                // }
                // else {
                //     creep.memory.dst = "storage"
                // }
                creep.memory.state = "store";
                break collect
            }
            const src = DeliveryManager.cache[DeliveryManager.name(creep.room)].parent.managers.filter(([name, prd]) => prd.name == creep.memory.src).values().next().value
            console.log(src.name)
            creep.memory.destination = src.destination()

            // let size = 0;
            // let idx = 0;
            // for(const iR in resourceList) {
            //     if(resourceList[iR].amount > size) {
            //         size = resourceList[iR].amount;
            //         idx = iR;
            //     }
            // }
            // const res = resourceList[idx];
            // // const res = creep.pos.findClosestByRange(ress);
            // if(creep.pos.getRangeTo(res) <= 1) {
            //     creep.pickup(res)
            // }
            // else if(creep.pos.getRangeTo(res) <= 3) {
            //     creep.moveTo(res);
            // }
            // else {
            //     creep.memory.retries = 0;
            //     const path = creep.room.findPath(creep.pos, res.pos, {range: 1, ignoreCreeps: true})
            //     creep.memory.path = Room.serializePath(path)
            //     return
            // }
        }
        store: if(creep.memory.state == "store") {
            if(creep.store.getUsedCapacity() == 0) {
                DeliveryManager.cache[DeliveryManager.name(creep.room)].deliveryCompleted(creep)
                creep.memory.state = "collect";
                break store
            }
            DeliveryManager.cache[DeliveryManager.name(creep.room)].planDelivery(creep)
            break store
            if(creep.memory.dst == "spawn") {
                /** @type StructureSpawn */
                const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                if(spawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    if(creep.pos.getRangeTo(spawn) <= 1) {
                        creep.transfer(spawn, RESOURCE_ENERGY)
                        return
                    }
                    else {
                        creep.memory.retries = 0;
                        const path = creep.room.findPath(creep.pos, spawn.pos, {range: 1, ignoreCreeps: true})
                        creep.memory.path = Room.serializePath(path)
                        return
                    }
                }
                else {
                    /** @type Array.<StructureExtension> */
                    const exts = creep.room.find(FIND_STRUCTURES,
                        {filter: (s) => s.structureType == STRUCTURE_EXTENSION});

                    for (const iE in exts) {
                        const ext = exts[iE];
                        if (ext.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                            if(creep.pos.getRangeTo(ext) <= 1) {
                                creep.transfer(ext, RESOURCE_ENERGY)
                                return
                            }
                            else {
                                creep.memory.retries = 0;
                                const path = creep.room.findPath(creep.pos, ext.pos, {range: 1, ignoreCreeps: true})
                                creep.memory.path = Room.serializePath(path)
                                return
                            }
                        }
                    }
                }
                creep.memory.dst = "storage"
            }
            else if(creep.memory.dst == "ctrl") {
                var ctrl = creep.room.controller;
                if(creep.pos.getRangeTo(ctrl) > 2) {
                    creep.moveTo(ctrl);
                    return
                }
                else {
                    creep.drop(RESOURCE_ENERGY);
                    return
                }
            }
            else if(creep.memory.dst == "storage") {
                const containerList = creep.room.find(FIND_STRUCTURES,
                    {filter: (s) => s.structureType == STRUCTURE_CONTAINER});
                
                if(containerList.length == 0) {
                    let spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                    if(creep.pos.getRangeTo(spawn) > 2) {
                        creep.moveTo(spawn);
                        return
                    }
                    else {
                        creep.drop(RESOURCE_ENERGY);
                        return
                    }
                }
                else {
                    for(const c_i in containerList) {
                        const cont = containerList[c_i];
                        if(cont.store.getFreeCapacity() > 0) {
                            if(creep.transfer(cont, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                                creep.moveTo(cont);
                                return
                            }
                        }
                    }
                }
            }
        }

	}
};

module.exports = roleMule;