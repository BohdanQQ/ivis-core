const RequestType = {
    CREATE_SIG: 0,
    STORE_STATE: 1,
};

const RemoteRunState = {
    SUCCESS: 0,
    BUILD_FAIL: 1,
    RUN_FAIL: 2,
    RUNNING: 3,
    QUEUED: 4,
};

module.exports = { RequestType, RemoteRunState }