const config = require('../../../config');
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
const RPS_PEER_PORT_TRUSTED = 10329;
const RPS_PEER_PORT_SBOX = 10330;
const RPS_PEER_PORT_ES = 10328;
const RPS_PUBLIC_PORT = 10327;

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

  maxJobOutput: ${config.tasks.maxRunOutputBytes || 1000000}
  
  workCheckInterval: 5 # seconds
  printLimitReachedMessage: true
  messagePush:
    # how many times a message push will be retried in case of failure
    maxRetryCount: 2
    retryInterval: 2 # seconds
    pushDestination: "/rest/remote"
`;

const getRJRNginxConfig = (instancePrivateIp) => `events {
}

http {
server {
   listen ${RJR_LISTEN_PORT};
   server_name ${instancePrivateIp};

   access_log    /opt/a.log;
   error_log     /opt/e.log;


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

const RPS_LISTEN_PORT = 10000;

const PATHS = {
    machineClient: 0, ca: 1, cert: 2, key: 3
}

const __PATH_DATA = {
    [PATHS.machineClient]: {
        container: '/opt/machine.pem',
        physical: './cert/machine.pem'
    },
    [PATHS.ca]: {
        container: '/opt/ca.cert',
        physical: './cert/ca.cert'
    },
    [PATHS.cert]: {
        container: '/opt/svr.pem',
        physical: './cert/svr.pem'
    },
    [PATHS.key]: {
        container: '/opt/svr.key',
        physical: './cert/svr.key'
    },
}

/**
 * @returns {{container: string, physical: string}}
 */
function path(pathType) {
    return __PATH_DATA[pathType];
}


const RPSComposeFile = `version: '3'
services:
  rps-proxy:
    image: httpd:2.4.54
    volumes:
      - ./config/apache/apache.conf:/usr/local/apache2/conf/httpd.conf:ro
      - ./config/apache/vhosts.conf:/usr/local/apache2/conf/extra/httpd-vhosts.conf:ro
      # assumes the certificates are generated locally first
      - ${path(PATHS.machineClient).physical}:${path(PATHS.machineClient).container}:ro # simple concatenation of the ${path(PATHS.cert).container} and ${path(PATHS.key).container} files
      # here goes the local CA certificate as generated in ivis-core/certs/remote/ca folder
      - ${path(PATHS.ca).physical}:${path(PATHS.ca).container}:ro
      - ${path(PATHS.cert).physical}:${path(PATHS.cert).container}:ro
      - ${path(PATHS.key).physical}:${path(PATHS.key).container}:ro
    ports:
      - ${RPS_PUBLIC_PORT}:${RPS_PUBLIC_PORT}
      - ${RPS_PEER_PORT_TRUSTED}:${RPS_PEER_PORT_TRUSTED}
      - ${RPS_PEER_PORT_SBOX}:${RPS_PEER_PORT_SBOX}
      - ${RPS_PEER_PORT_ES}:${RPS_PEER_PORT_ES}
  rps:
    restart: always
    build:
      context: ./
      dockerfile: ./Dockerfile
      network: host
    volumes:
      - ./config:/opt/ivis-rps/config
`;

const getRPSConfigFile = (peerIps) => `
rps:
    port: ${RPS_LISTEN_PORT}
    peerIPs: [${peerIps.map((ip) => `'${ip}'`).join(',')}]
    peerRJRPort: ${RJR_PUBLIC_PORT}
`;

function proxyTo(location, name) {
    return `LogLevel info ssl:warn
    ErrorLog /var/log/apache_${name}_error.log

    ProxyRequests On
    SSLProxyEngine On

    SSLProxyMachineCertificateFile ${path(PATHS.machineClient).container}
    SSLProxyCACertificateFile ${path(PATHS.ca).container}
    SSLProxyCheckPeerCN on
    SSLProxyCheckPeerExpire on
    SSLProxyVerify require
    SSLProxyVerifyDepth 4

    ProxyPass "/" "${location}/"
    ProxyPassReverse "/" "${location}/"

    <Proxy *>
            Order deny,allow
            Allow from all
    </Proxy>
    `;
}

const getRPSApacheProxyConfig = (publicIp, privateIp) => `
SSLSessionCache "shmcb:/usr/local/apache/logs/ssl_gcache_data(512000)"
<VirtualHost *:${RPS_PUBLIC_PORT}> # PUBLIC PORT - FORWARD TO SCHEDULER
    ServerName ${publicIp}:${RPS_PUBLIC_PORT}
    SSLProtocol -all +TLSv1.2
    SSLEngine on

    SSLCertificateFile ${path(PATHS.cert).container}
    SSLCertificateKeyFile ${path(PATHS.key).container}
    SSLCACertificateFile ${path(PATHS.ca).container}

    SSLVerifyDepth 3
    SSLOptions +StdEnvVars +ExportCertData


    LogLevel info ssl:warn
    ErrorLog /var/log/apache_public_https_error.log
	# additional location makes sure nobody but the peers can access /rest/remote/emit 
    # (if the other port which accesses the RPS node app is restricted to peers only...)
	<Location "/rps">
		ProxyPreserveHost On
		ProxyPass "http://rps:${RPS_LISTEN_PORT}/rps"
		ProxyPassReverse "http://rps:${RPS_LISTEN_PORT}/rps"
	</Location>

</VirtualHost>

<VirtualHost *:${RPS_PEER_PORT_ES}>
    ServerName ${privateIp}:${RPS_PEER_PORT_ES}

    ${proxyTo(config.www.remoteElasticsearchBase, 'peer_es')}

</VirtualHost>

<VirtualHost *:${RPS_PEER_PORT_TRUSTED}>
    ServerName ${privateIp}:${RPS_PEER_PORT_TRUSTED}

    ${proxyTo(config.www.trustedUrlBase, 'peer_trusted')}
</VirtualHost>

<VirtualHost *:${RPS_PEER_PORT_SBOX}>
    ServerName ${privateIp}:${RPS_PEER_PORT_SBOX}

    ${proxyTo(config.www.sandboxUrlBase, 'peer_sbox')}
</VirtualHost>`;

function getRJRSetupCommands(masterInstancePrivateIp, instancePrivateIp) {
    // TODO move to config
    const repo = 'https://github.com/BohdanQQ/ivis-remote-job-runner.git';
    const commit = 'e710f800bf7b9fe3c7e1c2b671bbd09466b92ffe';
    const composeContents = RJRComposeFile;
    const nginxConfigContents = getRJRNginxConfig(instancePrivateIp);
    const rjrConfigContents = getRJRConfigFile(masterInstancePrivateIp);
    const cmdInRepo = (cmd) => `cd ./ivis-remote-job-runner && ${cmd}`;

    return [
        // allow only the master instance to connect to the docker RJR_LISTEN_PORT
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RJR_LISTEN_PORT} ! -s ${masterInstancePrivateIp}/32 -j DROP`,
        `git clone ${repo}`, // TODO fix the location (make it independent of repo name)
        cmdInRepo(`git checkout ${commit}`),
        cmdInRepo(`cat > ./config/default.yml << HEREDOC_EOF\n${rjrConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./config/nginx/nginx.conf << HEREDOC_EOF\n${nginxConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./docker-compose.yml << HEREDOC_EOF\n${composeContents}\nHEREDOC_EOF`),
        cmdInRepo(`sudo /usr/local/bin/docker-compose up -d --build`),
    ];
}
if ([RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED].indexOf(RPS_PUBLIC_PORT) !== -1) {
    throw new Error("Port clash on master peer!");
}
if ([RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED].indexOf(RJR_PUBLIC_PORT) !== -1) {
    throw new Error("Port clash on master peer!");
}
function getRPSSetupCommands(peerPrivateIps, masterInstancePrivateIp, masterInstancePublicIp, subnetMask, caCert, cert, key) {
    const repo = 'https://github.com/BohdanQQ/ivis-remote-pool-scheduler';
    const commit = '0c677cd4d8b3a1e59380446b84b9f2a588f2a02a';
    const apacheConfigContents = getRPSApacheProxyConfig(masterInstancePublicIp, masterInstancePrivateIp);
    const rpsConfigContents = getRPSConfigFile(peerPrivateIps);
    const cmdInRepo = (cmd) => `cd ./ivis-remote-pool-scheduler && ${cmd}`;

    return [
        // make PEER ports PEER-only 
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_ES} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_SBOX} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PEER_PORT_TRUSTED} ! -s ${subnetMask} -j DROP`,
        `sudo iptables -I DOCKER-USER -i ens3 -p tcp --dport ${RPS_PUBLIC_PORT} -j RETURN`, // make public port public (topmost rule)
        `git clone ${repo}`,
        cmdInRepo(`git checkout ${commit}`),
        cmdInRepo(`mkdir ./cert`),
        cmdInRepo(`cat > ./config/default.yml << HEREDOC_EOF\n${rpsConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./config/apache/vhosts.conf << HEREDOC_EOF\n${apacheConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./docker-compose.yml << HEREDOC_EOF\n${RPSComposeFile}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.ca).physical} << HEREDOC_EOF\n${caCert}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.cert).physical} << HEREDOC_EOF\n${cert}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.key).physical} << HEREDOC_EOF\n${key}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.machineClient).physical} << HEREDOC_EOF\n${cert}${key}\nHEREDOC_EOF`),
        cmdInRepo(`chmod +x ./setup/docker-entry.sh`),
        cmdInRepo(`sudo /usr/local/bin/docker-compose up -d --build`),
    ];
}

module.exports = { getRJRSetupCommands, getRPSSetupCommands }