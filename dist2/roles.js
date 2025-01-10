const roleHarvester = require('./role.harvester');
const roleMule = require('./role.mule');
const roleUpgrader = require('./role.upgrader');
const logger = require('./logger');
// Import other roles here as they are added
// const roleBuilder = require('./role.builder');
// const roleUpgrader = require('./role.upgrader');

const roles = {
    harvester: roleHarvester,
    mule: roleMule,
    upgrader: roleUpgrader,
    // Add other roles here as they are created
    // builder: roleBuilder,
    // upgrader: roleUpgrader,
};

module.exports = {
    /**
     * Run the role behavior for a given creep
     * @param {Creep} creep - The creep to run the role for
     * @returns {void}
     */
    run: function(creep) {
        if (creep.spawning) return;
        
        const role = creep.memory.role;
        if (!role || !roles[role]) {
            logger.warn(`Creep ${creep.name} has invalid role: ${role}`);
            return;
        }
        
        try {
            roles[role].run(creep);
        } catch (error) {
            logger.error(`Error running role ${role} for creep ${creep.name}: ${error}`);
        }
    },

    /**
     * Check if a role exists
     * @param {string} role - The role name to check
     * @returns {boolean}
     */
    exists: function(role) {
        return !!roles[role];
    },

    /**
     * Get all available role names
     * @returns {string[]}
     */
    getAll: function() {
        return Object.keys(roles);
    }
};
