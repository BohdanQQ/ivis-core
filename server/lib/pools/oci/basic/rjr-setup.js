const RJR_LISTEN_PORT = 9443;
const RJR_PUBLIC_PORT = 9090;
const RJRComposeFile = `version: '3'
services:
  rjr-proxy:
    restart: always
    image: nginx
    volumes:
      - ./config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      # - ./cert/:/opt/cert:ro # not used here
      # in IVIS-core ${RJR_PUBLIC_PORT} should be set as the executor port parameter
    ports:
      - ${RJR_PUBLIC_PORT}:${RJR_LISTEN_PORT}
    depends_on:
      - rjr

  rjr:
    restart: always
    build:
      context: ./
      dockerfile: ./Dockerfile
      network: host
    volumes:
    # database directory
      - ./data:/opt/ivis-remote/data
    # job files, builds
      - ./files:/opt/ivis-remote/files
      - ./config/default.yml:/opt/ivis-remote/config/default.yml
      # - ./cert:/opt/ivis-remote/cert # not used
`;

const getRJRConfigFile = (masterPeerIp) => `# all paths are relative to the project root
ivisCore:
  trustedIPOrName: ${masterPeerIp}
  trustedAuthPort: 443
  
  sandboxIPOrName: ${masterPeerIp}
  sandboxPort: 444 # MUST BE DIFFERENT (name is not different!)

  es:
    host: ${masterPeerIp}
    port: 8446
  # use local CA when PERFORMING REQUESTS to accept a locally-issued certificate
  # e.g. when not running on the internet...
  # Set to false if the IVIS-core server certificate may be verified normally 
  # (using global certificate chain of trust)
  useLocalCA: true
  CACert: ./cert/ca.cert
  venvCmd: 'python3 -m venv'

jobRunner:

 # should always be true, is here just in case it is needed in the future
  useCertificates: false
  # IVIS-core-issued server certificate
  # (used when IVIS-core sends requests to the runner)
  serverCert:
    certPath: ./cert/rjr.cert
    keyPath:  ./cert/rjr.pem

  # IVIS-core-issued client certificate
  # (used when the runner sends requests to IVIS-core)
  # may be identical to server certificate
  clientCert:
    certPath: ./cert/rjr.cert
    keyPath:  ./cert/rjr.pem
  
  # this one should not really change when using docker, 
  # since it is very much internal to the docker compose setup 
  port: 8080

  # in case certificate serial number is not used for some reason
  machineId: 0

  maxJobOutput: 1000000
  
  workCheckInterval: 5 # seconds
  printLimitReachedMessage: true
  messagePush:
    # how many times a message push will be retried in case of failure
    maxRetryCount: 0
    retryInterval: 1 # seconds
    pushDestination: "/rest/remote"
`;

const getRJRNginxConfig = (instancePrivateIp) => `events {
}

http {
server {
   listen ${RJR_LISTEN_PORT};
   # usually only this directive needs to be modified
   server_name ${instancePrivateIp};

   access_log    /opt/a.log;
   error_log     /opt/e.log debug;


   location / {
        proxy_pass http://rjr:8080;

        proxy_set_header        Host $host;
        proxy_set_header        X-Real-IP $remote_addr;
        proxy_set_header        X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto $scheme;
}
}
}
`;


function getRJRSetupCommands(masterInstancePrivateIp, instancePrivateIp) {
    const repo = 'https://github.com/BohdanQQ/ivis-remote-job-runner.git';
    const commit = 'e9803c10344c1d443928a8d5c10043a21ee1c3d5';
    const composeContents = RJRComposeFile;
    const nginxConfigContents = getRJRNginxConfig(instancePrivateIp);
    const rjrConfigContents = getRJRConfigFile(masterInstancePrivateIp);
    return [
        // allow only the master instance to connect to the docker network (where RJR will be responding)
        `sudo firewall-cmd --zone=docker --add-source=${masterInstancePrivateIp}/32 --permanent`,
        'sudo firewall-cmd --complete-reload',
        `git clone ${repo}`,
        `cd ./ivis-remote-job-runner && git checkout ${commit}`,
        `cd ./ivis-remote-job-runner && cat > ./config/default.yml << HEREDOC_EOF\n${rjrConfigContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && cat > ./config/nginx/nginx.conf << HEREDOC_EOF\n${nginxConfigContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && cat > ./docker-compose.yml << HEREDOC_EOF\n${composeContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && sudo /usr/local/bin/docker-compose up -d --build`
    ];
}

const RPS_LISTEN_PORT = 443;

function getRPSSetupCommands(peerPrivateIps, masterInstancePrivateIp, masterInstancePublicIp) {
    const nonRPSPrivateIps = peerPrivateIps.filter((ip) => ip !== masterInstancePrivateIp);
    // add other pool peers to the docker whitelist
    let commands = nonRPSPrivateIps.map((ip) => `sudo firewall-cmd --zone=docker --add-source=${ip}/32 --permanent`);
    // open the public port to public
    let otherCommands = [`sudo firewall-cmd --zone=public --add-port=${RPS_LISTEN_PORT}/tcp`];
    return commands.push(...otherCommands);
}

module.exports = { getRJRSetupCommands }