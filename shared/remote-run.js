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
    REMOTE_RUNNER_AGENT: 'agent',
    OCI_BASIC: 'oci_basic'
};
Object.freeze(MachineTypes);

const MachineTypeParams = {
    [MachineTypes.LOCAL]: [],
    [MachineTypes.REMOTE_RUNNER_AGENT]: [{
        'id': 'port',
        'label': 'Port',
        'help': 'the port the Remote Job Runner is available on',
        'type': 'integer',
    }],
    [MachineTypes.OCI_BASIC]: [{
        'id': 'size',
        'label': 'Pool Size',
        'help': 'Machine pool size',
        'type': 'integer',
    },
    {
        'id': 'tenancyID',
        'label': 'Tenancy ID',
        'help': 'OCID of the tenancy used to create pool\'s VMs',
        'type': 'string',
    },
    {
        'id': 'compartmentID',
        'label': 'Compartment ID',
        'help': 'OCID of the compartment used to create pool\'s VMs',
        'type': 'string',
    },
    {
        'id': 'shape',
        'label': 'Shape',
        'help': 'The shape of each of the pool\'s VM',
        'type': 'string',
    },
    {
        'id': 'shapeConfigCPU',
        'label': 'Flexible Shape CPUs',
        'help': 'Number of CPU cores (used if shape is flexible)',
        'type': 'integer',
    },
    {
        'id': 'shapeConfigRAM',
        'label': 'Flexible Shape RAM',
        'help': 'GBs of RAM (used if shape is flexible)',
        'type': 'integer',
    },
    ]
}
Object.freeze(MachineTypeParams);

const ExecutorStatus = {
    READY: 0,
    PROVISIONING: 1,
    FAIL: 2
}
Object.freeze(ExecutorStatus);


module.exports = { RequestType, RemoteRunState, MachineTypes, MachineTypeParams, ExecutorStatus }