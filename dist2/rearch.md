# Screeps Bot Architecture

## Table of Contents
- [Resource Management System](#resource-management-system)
  - [Source Management System](#source-management-system)
  - [Resource Lifecycles](#resource-lifecycles)
  - [Priority System Design](#priority-system-design)
  - [Memory Persistence](#memory-persistence)
- [Resource Transportation Design](#resource-transportation-design)
  - [Mule Role Architecture](#mule-role-architecture)
  - [Task Template System](#task-template-system)
- [Room Management System](#room-management-system)
  - [Integration with Resource Management](#integration-with-resource-management)
- [Creep Role System](#creep-role-system)
  - [Role Registry](#role-registry)
  - [Error Handling](#error-handling)
- [State Management and Initialization](#state-management-and-initialization)

## Resource Management System

The **Resource Management System** is the backbone of the bot’s operations. It manages:
- Game resources (e.g., sources, creeps)  
- Creep orders (creation, lifecycle states, priorities)  
- Spawn processes and memory persistence  

```mermaid
classDiagram
    class ResourceManager {
        +applyResource(type, config)
        +deleteResource(type, id)
        +getResourceById(type, id)
        +getResourcesOfType(type)
    }
    class SourceController {
        +reconcile()
        +calculateWorkPlaces()
    }
    class RoomController {
        +reconcile()
    }
    class SpawnController {
        +reconcile()
    }
    class CreepOrder {
        +schema
        +role
        +priority
        +status
        +memory
        +creepId
    }
    class SpawnProcess {
        +orderId
        +spawnId
        +status
    }

    ResourceManager --> CreepOrder : creates/manages
    ResourceManager --> SpawnProcess : creates/manages
    SourceController --> ResourceManager : uses
    RoomController --> ResourceManager : uses
    SpawnController --> ResourceManager : uses
    CreepOrder --> SpawnProcess : tracked by
```

Key components:
1. **ResourceManager** – Central system for creating and managing resource records (e.g., `CreepOrder`, `SpawnProcess`).  
2. **SourceController**, **RoomController**, **SpawnController** – Specialized controllers that manage specific game aspects by interacting with the `ResourceManager`.  
3. **CreepOrder**, **SpawnProcess** – Resource types used for creep/harvester ordering and spawn workflow tracking.

### Source Management System

The **Source Management System** handles energy sources and ensures harvesters are spawned and assigned.  

```mermaid
flowchart TD
    A[SourceController] -->|reconcile| B[Check Sources]
    B -->|for each source| C[Calculate Work Places]
    C --> D[Check Existing Harvesters]
    D --> E{Enough Harvesters?}
    E -->|No| F[Create Harvester Orders]
    E -->|Yes| G[Monitor Status]
    
    subgraph Work Places
        C1[Get Terrain] --> C2[Check Adjacent Tiles]
        C2 --> C3[Filter Non-Wall Tiles]
        C3 --> C4[Count Available Spots]
    end
    
    subgraph Harvester Management
        F1[Calculate Required Count] --> F2[Create New Orders]
        F2 --> F3[Assign Basic Body Parts]
        F3 --> F4[Assign to Source]
    end
```

- **Work Place Calculation**: Identifies non-wall terrain around sources to determine maximum harvesters.  
- **Harvester Management**: Ensures each source has an optimal number of harvesters. Creates or adjusts `CreepOrder` records as needed.  
- **Resource Integration**: Relies on `ResourceManager` for tracking creeps and linking them to specific sources.

### Resource Lifecycles

```mermaid
stateDiagram-v2
    state CreepOrder {
        [*] --> pending : Order Created
        pending --> spawning : Spawn Started
        spawning --> active : Spawn Complete
        active --> pending : Creep Dies
    }
    
    state SpawnProcess {
        [*] --> spawning : Process Created
        spawning --> completed : Creep Spawned
        spawning --> failed : Spawn Failed
        completed --> [*] : Process Removed
        failed --> [*] : Process Removed
    }
```

- **CreepOrder** represents persistent creep needs. When a creep dies, the order reverts to pending for respawn.  
- **SpawnProcess** tracks a spawn event, removed upon success or failure.  

### Priority System Design

To ensure consistent ordering and spawning:

```mermaid
flowchart TD
    A[Source Found] --> B[Calculate Work Places]
    B --> C[Create Harvester Orders]
    C --> D[Calculate Harvester Priority]
    D --> E[Create Mule Orders]
    
    subgraph Priority Calculation
        D1[Take first 6 chars of Source ID] --> D2[Convert from hex to decimal]
        D2 --> D3[Multiply by constant, e.g. 100]
        D3 --> D4[Floor result]
    end
    
    subgraph Mule Priority
        E1[Take Harvester Priority] --> E2[Subtract 10]
        E2 --> E3[Assign to Mule]
    end
```

- **Harvester Priority** = `floor(parseInt(sourceId.substring(0, 6), 16) * 100)`  
- **Mule Priority** = `(Harvester Priority) - 10`  

This deterministic system assigns unique priorities per source, ensuring harvesters spawn before mules, while preserving stable ordering across ticks.

### Memory Persistence

All creep orders are stored in `Memory`, retaining:
- Priority  
- Source assignment  
- Any other config data (role, tasks, etc.)  

This data is maintained across game resets, ensuring stable or re-initialized states when VMs or the script environment restarts.

## Resource Transportation Design

### Mule Role Architecture

The **Mule Role** uses a simple state machine for resource transport:

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> COLLECTING: Has collect tasks & free capacity
    IDLE --> DELIVERING: Has deliver tasks & resources
    COLLECTING --> DELIVERING: Inventory full
    DELIVERING --> COLLECTING: Inventory empty
```

1. **IDLE**: No immediate tasks or waiting for next assignment.  
2. **COLLECTING**: Gathering resources until capacity is reached.  
3. **DELIVERING**: Delivering resources to designated targets (spawn, controller, or storage).

### Task Template System

```mermaid
classDiagram
    class Task {
        +type: string
        +resourceType: string
    }
    
    class EntityTask {
        +type: "entity"
        +id: string
    }
    
    class AreaTask {
        +type: "area"
        +pos: Position
        +range: number
        +entityType: string
        +structureTypes?: string[]
        +roles?: string[]
    }
    
    Task <|-- EntityTask
    Task <|-- AreaTask
```

- **EntityTask**: Interact with a specific game object.  
- **AreaTask**: Search an area within a given range for valid objects.  

This flexible system allows the Mule to adapt to various collection/delivery scenarios.

---

## Room Management System

```mermaid
graph TD
    RC[RoomController] -->|manages| Sources
    RC -->|creates| Orders[Creep Orders]
    Orders -->|contains| MuleOrders[Mules per Source]
    Orders -->|contains| UpgraderOrders[Upgraders]
    
    subgraph Per Source Setup
        MuleOrders -->|Mule 1| SpawnDelivery[Spawn Delivery]
        MuleOrders -->|Mule 2| ControllerDelivery[Controller Delivery]
        UpgraderOrders --> ControllerUpgrade[Controller Upgrading]
    end
    
    subgraph Metadata Tracking
        Orders -->|tracks| SourceAssignment[Source ID]
        Orders -->|tracks| Role[Creep Role]
        Orders -->|contains| Templates[Task Templates]
    end
```

1. **RoomController** orchestrates each room, ensuring each source has enough creeps:
   - Typically, 1 or more Mules per source (spawn tasks, controller tasks, etc.)  
   - Upgrader creeps for controller upgrades.  
2. **Metadata Tracking** ties each creep order to its source and desired tasks.

### Integration with Resource Management

```mermaid
graph LR
    RC[RoomController] -->|queries| RM[Resource Manager]
    RC -->|creates| Orders[Creep Orders]
    
    subgraph Resource Manager
        RM -->|manages| Resources[Resource Types]
        Resources -->|includes| CreepOrders[Creep Orders]
        Resources -->|includes| OtherTypes[Other Resources]
        
        RM -->|provides| Query[Query Methods]
        Query -->|by field| Field[getResourceByField]
        Query -->|by type| Type[getResourcesOfType]
    end
    
    subgraph Order Lifecycle
        Orders -->|created| New[New Order]
        New -->|status| Pending[Pending]
        Pending -->|status| Active[Active]
        Active -->|status| Expired[Expired]
    end
```

- **RoomController** uses `ResourceManager` to lookup or create orders.  
- **Order Lifecycle** from creation to either success or renewal if creeps die.  

This ensures:
- Consistent resource distribution.  
- Persistent assignments and tasks.  
- Clear role separation and maintenance of creep statuses.

---

## Creep Role System

The **Creep Role System** provides the logic for each creep type, managed by a central registry.

```mermaid
classDiagram
    class RoleRegistry {
        +run(creep)
        +exists(role)
        +getAll()
    }
    class Role {
        +run(creep)
    }
    class ErrorHandler {
        +handleInvalidRole(creep, role)
        +handleRoleError(creep, role, error)
    }

    RoleRegistry --> Role : manages
    RoleRegistry --> ErrorHandler : uses
    Role <|-- HarvesterRole
    Role <|-- BuilderRole
    Role <|-- UpgraderRole
    Role <|-- MuleRole
```

### Role Registry
1. Maintains a collection of implementations (Harvester, Mule, etc.).  
2. Provides a `run(creep)` interface to execute the appropriate role logic.  
3. Offers validation and utility methods.  

### Error Handling
1. Detects and logs invalid roles.  
2. Catches runtime errors, logs details for debugging.  
3. Prevents game loop crashes by isolating role logic from system-critical code.

---

## State Management and Initialization

A robust initialization ensures the bot can recover from resets and maintain stable operation:

```mermaid
flowchart TD
    A[Game Tick Start] --> B{First Tick?}
    B -->|Yes| C[Initialize System]
    B -->|No| D[Regular Loop]
    C --> E[Register Resource Types]
    E --> F[Initialize Controllers]
    F --> D
    D --> G[Controller Reconciliation]
    G --> H[Save State]
    H --> I[Game Tick End]
```

1. **Initialization Detection** – A module flag indicating if the system has been set up this session.  
2. **Controller Pattern** – Controllers (`SourceController`, `RoomController`, etc.) each handle reconciliation logic.  
3. **State Recovery** – Missing resources are recreated if they’re expected (e.g., sources).  
4. **Error Handling** – If errors are unrecoverable, a re-init can be forced on the next tick.

```mermaid
classDiagram
    class MainLoop {
        -initialized: boolean
        +loop()
    }
    class Controller {
        +reconcile()
    }
    class ResourceManager {
        -resources: Map
        -resourceTypes: Map
        +registerResourceType()
        +load()
        +save()
    }
    
    MainLoop --> Controller : initializes
    Controller --> ResourceManager : uses
    ResourceManager --> Memory : persists
```

This system guarantees:
- One-time resource registration each session.  
- Automatic re-init if the VM resets.  
- Consistent, robust state across game ticks.
