'use strict';

const RequestType = {
    CREATE_SIG: 0,
    STORE_STATE: 1,
};
Object.freeze(RequestType);

const RemoteRunState = {
    SUCCESS: 0,
    RUN_FAIL: 2,
    RUNNING: 3,
    QUEUED: 4,
};
Object.freeze(RemoteRunState);

const MachineTypes = {
    LOCAL: 'local',
    REMOTE_RUNNER_AGENT: 'agent'
};
Object.freeze(MachineTypes);

const MachineTypeParams = {
    [MachineTypes.LOCAL]: [],
    [MachineTypes.REMOTE_RUNNER_AGENT]: [{
        'id': 'port',
        'label': 'Port',
        'help': 'the port the Remote Job Runner is available on',
        'type': 'integer',
    }] 
}
Object.freeze(MachineTypeParams); 

module.exports = { RequestType, RemoteRunState, MachineTypes, MachineTypeParams }