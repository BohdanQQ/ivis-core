const RJR_LISTEN_PORT = 80;
const RJR_PUBLIC_PORT = 80;

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
// all three should be forwarded with XXXX:XXXX on RPS
const RPS_PEER_PORT_TRUSTED = 444;
const RPS_PEER_PORT_SBOX = 445;
const RPS_PEER_PORT_ES = 446;

const getRJRConfigFile = (masterPeerIp) => `# all paths are relative to the project root
ivisCore:
  trustedIPOrName: ${masterPeerIp}
  trustedAuthPort: ${RPS_PEER_PORT_TRUSTED}
  
  sandboxIPOrName: ${masterPeerIp}
  sandboxPort: ${RPS_PEER_PORT_SBOX} # MUST BE DIFFERENT (name is not different!)

  es:
    host: ${masterPeerIp}
    port: ${RPS_PEER_PORT_ES}
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

        proxy_set_header        Host ${'$host'};
        proxy_set_header        X-Real-IP ${'$remote_addr'};
        proxy_set_header        X-Forwarded-For ${'$proxy_add_x_forwarded_for'};
        proxy_set_header        X-Forwarded-Proto ${'$scheme'};
}
}
}
`;


function getRJRSetupCommands(masterInstancePrivateIp, instancePrivateIp) {
    const repo = 'https://github.com/BohdanQQ/ivis-remote-job-runner.git';
    const commit = 'e710f800bf7b9fe3c7e1c2b671bbd09466b92ffe';
    const composeContents = RJRComposeFile;
    const nginxConfigContents = getRJRNginxConfig(instancePrivateIp);
    const rjrConfigContents = getRJRConfigFile(masterInstancePrivateIp);
    return [
        // allow only the master instance to connect to the docker RJR_LISTEN_PORT
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RJR_LISTEN_PORT} ! -s ${masterInstancePrivateIp} -j DROP`,
        `git clone ${repo}`,
        `cd ./ivis-remote-job-runner && git checkout ${commit}`,
        `cd ./ivis-remote-job-runner && cat > ./config/default.yml << HEREDOC_EOF\n${rjrConfigContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && cat > ./config/nginx/nginx.conf << HEREDOC_EOF\n${nginxConfigContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && cat > ./docker-compose.yml << HEREDOC_EOF\n${composeContents}\nHEREDOC_EOF`,
        `cd ./ivis-remote-job-runner && sudo /usr/local/bin/docker-compose up -d --build`
    ];
}
const RPS_PUBLIC_PORT = 10443; // must be forwarded with 10443:10443
if ([RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED].indexOf(RPS_PUBLIC_PORT) !== -1) {
    throw new Error("Port clash on master peer!");
}
if ([RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED].indexOf(RJR_PUBLIC_PORT) !== -1) {
    throw new Error("Port clash on master peer!");
}
function getRPSSetupCommands(peerPrivateIps, masterInstancePrivateIp, masterInstancePublicIp, subnetMask) {
    return [
        // make PEER ports PEER-only 
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_ES} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_SBOX} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_TRUSTED} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PUBLIC_PORT} -j RETURN`, // make public port public (topmost rule)
        'touch ./helloRPS.txt'
    ];
}

module.exports = { getRJRSetupCommands }