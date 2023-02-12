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
        'label': 'ipv4Address',
        'help': 'jeIpv4AddressHelp',
        'type': 'string',
    },
    {
        'id': 'hostname',
        'label': 'hostname',
        'help': 'jeHostnameHelp',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'port',
        'help': 'jePortRJRHelp',
        'type': 'integer',
    },
    ],
    [MachineTypes.OCI_BASIC]: [{
        'id': 'size',
        'label': 'poolSize',
        'help': 'jePoolSizeHelp',
        'type': 'integer',
    },
    {
        'id': 'shape',
        'label': 'shape',
        'help': 'jeOCIShapeHelp',
        'type': 'string',
    },
    {
        'id': 'shapeConfigCPU',
        'label': 'jeOCIFlexCPUs',
        'help': 'jeOCIFlexCPUsHelp',
        'type': 'integer',
    },
    {
        'id': 'shapeConfigRAM',
        'label': 'jeOCIFlexRAM',
        'help': 'jeOCIFlexRAMHelp',
        'type': 'integer',
    },
    ],
    [MachineTypes.REMOTE_POOL]: [{
        'id': 'ip_address',
        'label': 'ipv4Address',
        'help': 'jeIpv4AddressHelp',
        'type': 'string',
    },
    {
        'id': 'hostname',
        'label': 'hostname',
        'help': 'jeHostnameHelp',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'port',
        'help': 'jePortRPSHelp',
        'type': 'integer',
    }],
    [MachineTypes.SLURM_POOL]: [
    {
        'id': 'hostname',
        'label': 'hostname',
        'help': 'jeHostnameSLURMHelp',
        'type': 'string',
    },
    {
        'id': 'port',
        'label': 'port',
        'help': 'jePortSLURMHelp',
        'type': 'integer',
    },
    {
        'id': 'username',
        'label': 'username',
        'help': 'jeUsernameSLURMHelp',
        'type': 'string',
    },
    {
        'id': 'password',
        'label': 'password',
        'type': 'password',
    },
    {
        'id': 'partition',
        'label': 'partition',
        'help': 'jePartitionSLURMHelp',
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