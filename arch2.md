# Redesigning `creepNeeded` and `addCreep`

## Objective
Replace the `creepNeeded` and `addCreep` methods with a more robust, scalable, and testable system. The new design will:
- Decouple the logic for determining creep requirements from the entities managing tasks.
- Provide a centralized mechanism for prioritizing and scheduling creep requests.
- Ensure the system integrates seamlessly with existing entities like `SourceManager`, `DeliveryManager`, and others.
- Allow incremental testing and debugging during development.

## Proposed Design

### **Core Components**

1. **CreepRequest**:
   - A standardized object that encapsulates all details of a creep request.
   - Fields:
     - `role`: The role of the creep (e.g., `harvester`, `mule`, `builder`).
     - `priority`: The urgency of the request.
     - `specifications`: Details like body parts, energy cost, and task-specific parameters.
     - `constraints`: Optional fields like room affinity, specific spawn preferences, etc.

   **Example:**
   ```javascript
   const creepRequest = {
       role: 'mule',
       priority: 'high',
       specifications: { parts: [CARRY, CARRY, MOVE], energyCost: 150 },
       constraints: { sourceRoom: 'W1N1' }
   };
   ```

2. **RequestManager** (New Component):
   - A centralized entity that manages all creep requests.
   - Responsibilities:
     - Receive requests from managers (e.g., `SourceManager`, `DeliveryManager`).
     - Maintain a prioritized queue of requests.
     - Allocate requests to available spawns based on constraints and room state.

3. **Existing Managers**:
   - `SourceManager`, `DeliveryManager`, and other entities will:
     - Focus on defining what is needed (e.g., “we need a mule for this delivery route”).
     - Generate `CreepRequest` objects and submit them to the `RequestManager`.

4. **RoomStateMonitor**:
   - Tracks real-time metrics like energy levels, spawn availability, and task status.
   - Provides data to the `RequestManager` for informed decision-making.

5. **SpawnManager**:
   - Executes the spawning of creeps based on assignments from the `RequestManager`.
   - Reports back on success or failure of creep creation.

---

### **Workflow**

1. **Request Creation**:
   - Managers (`SourceManager`, `DeliveryManager`, etc.) analyze their state and create `CreepRequest` objects based on current needs.
   - Requests are submitted to the `RequestManager`.

2. **Request Prioritization**:
   - The `RequestManager` prioritizes requests based on urgency, room state, and constraints.

3. **Spawn Assignment**:
   - The `RequestManager` assigns requests to the most suitable spawns based on:
     - Energy availability.
     - Proximity to the target location.
     - Existing queue lengths.

4. **Creep Creation**:
   - The `SpawnManager` spawns the creep and initializes its memory based on the `CreepRequest`.
   - Upon completion, the `RequestManager` is notified to update the request’s status.

5. **Testing Hooks**:
   - Integrate debug logs and test cases at each step:
     - Track request creation and submission.
     - Verify prioritization logic.
     - Simulate spawns with mocked energy levels and queue states.

---

### **Initial Implementation Plan**

#### Phase 1: Basic Request Handling
1. Implement the `CreepRequest` structure.
2. Create a basic `RequestManager` that:
   - Accepts requests.
   - Sorts them by priority.
   - Allocates them to a single spawn (no advanced constraints yet).
3. Modify `SourceManager` and `DeliveryManager` to use `RequestManager` instead of `creepNeeded`.

#### Phase 2: Advanced Features
1. Add support for multiple spawns with constraints (e.g., room affinity).
2. Integrate `RoomStateMonitor` for dynamic prioritization.
3. Extend `RequestManager` to handle failures (e.g., insufficient energy).

#### Phase 3: Testing and Optimization
1. Write unit tests for each component.
2. Simulate edge cases (e.g., multiple conflicting requests, no available spawns).
3. Optimize performance for larger colonies.

---

### **Example Code Snippet**

#### `RequestManager`
```javascript
class RequestManager {
    constructor() {
        this.queue = [];
    }

    addRequest(request) {
        this.queue.push(request);
        this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first
    }

    allocateRequest(spawns) {
        for (const request of this.queue) {
            const suitableSpawn = spawns.find(spawn => spawn.energy >= request.specifications.energyCost);
            if (suitableSpawn) {
                suitableSpawn.spawnCreep(request.specifications.parts, `${request.role}_${Game.time}`, {
                    memory: { role: request.role, ...request.constraints }
                });
                this.queue.splice(this.queue.indexOf(request), 1); // Remove from queue
                return;
            }
        }
    }
}
```

---

This design sets the foundation for replacing `creepNeeded` and `addCreep` with a scalable, testable system. As we implement and refine, we can expand on advanced features and ensure smooth integration with the existing game logic.

