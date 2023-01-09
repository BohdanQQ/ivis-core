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
    OCI_BASIC: 'oci_basic',
    REMOTE_POOL: 'remote_pool',
    SLURM_POOL: 'slurm'
};
Object.freeze(MachineTypes);

const MachineTypeParams = {
    [MachineTypes.LOCAL]: [],
    [MachineTypes.REMOTE_RUNNER_AGENT]: [{
        'id': 'ip_address',
        'label': 'IPv4 Address',
        'help': 'must be present, does not need to be valid if hostname is valid',
        'type': 'string',
    },
    {
        'id': 'hostname',
        'label': 'Hostname',
        'help': 'optional, prioritized over IP when present',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'Port',
        'help': 'the port the Remote Job Runner is available on',
        'type': 'integer',
    },
    ],
    [MachineTypes.OCI_BASIC]: [{
        'id': 'size',
        'label': 'Pool Size',
        'help': 'Machine pool size',
        'type': 'integer',
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
    ],
    [MachineTypes.REMOTE_POOL]: [{
        'id': 'ip_address',
        'label': 'IPv4 Address',
        'help': 'must be present, does not need to be valid if hostname is valid',
        'type': 'string',
    },
    {
        'id': 'hostname',
        'label': 'Hostname',
        'help': 'optional, prioritized over IP when present',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'Port',
        'help': 'the port the Remote Job Runner is available on',
        'type': 'integer',
    }],
    [MachineTypes.SLURM_POOL]: [
    {
        'id': 'hostname',
        'label': 'Hostname',
        'help': 'The Slurm Frontend Hostname',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'Port',
        'help': 'the SSH port to use',
        'type': 'integer',
    },
    {
        'id': 'username',
        'label': 'Username',
        'help': 'The username to use when logging with SSH',
        'type': 'string',
    },
    {
        'id': 'password',
        'label': 'Password',
        'help': 'Password to use when logging in',
        'type': 'password',
    },
    {
        'id': 'partition',
        'label': 'Partition',
        'help': 'The name of the partition to use',
        'type': 'string',
    },
    ],
}
Object.freeze(MachineTypeParams);

const ExecutorStatus = {
    READY: 0,
    PROVISIONING: 1,
    FAIL: 2
}
Object.freeze(ExecutorStatus);
// TODO rename the following two
const GlobalExecutorStateDefaults = {
    [MachineTypes.LOCAL]: {},
    [MachineTypes.REMOTE_RUNNER_AGENT]: {},
    [MachineTypes.REMOTE_POOL]: {},
    [MachineTypes.SLURM_POOL]: {},
    [MachineTypes.OCI_BASIC]: {
        'ipsUsed': [],
        'vcn': null,
        'routeTable': null,
        'gateway': null,
        'securityList': null,
    }
}
Object.freeze(GlobalExecutorStateDefaults);

const ExecutorStateDefaults = {
    [MachineTypes.LOCAL]: {},
    [MachineTypes.REMOTE_RUNNER_AGENT]: {},
    [MachineTypes.REMOTE_POOL]: {},
    [MachineTypes.SLURM_POOL]: {},
    [MachineTypes.OCI_BASIC]: {
        'subnetId': null,
        'subnetMask': null,
        'masterInstanceId': null,
        'masterInstanceIp': null,
        'masterInstanceSubnetIp': null,
        'poolInstanceIds': null,
    }
}
Object.freeze(ExecutorStateDefaults);

module.exports = { RequestType, RemoteRunState, MachineTypes, MachineTypeParams, ExecutorStatus, GlobalExecutorStateDefaults, ExecutorStateDefaults }