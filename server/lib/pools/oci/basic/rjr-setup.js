const config = require('../../../config');

// all containers are configured to run on the !!!host network!!!
// (to allow convenient configuration of the iptables using the VMs' subnet created in OCI)
// some containers, however, expose their ports to localhost only to protect them similarly
// to how the default docker network would (given no other application is proxying the same localhost port)

// Remote Job Runner (RJR):

// internal port for proxy -> RJR applicaion communication
const RJR_INTERNAL_PORT = 8080; // ideally exposed only to localhost
// for outside world -> (proxy -> RJR) communication
const RJR_LISTEN_PORT = 80;

// Remote Pool Scheduler (RPS):

// port for RJR to proxy to IVIS-core's trusted, sandbox, elasticsearch endpoint
const RPS_PEER_PORT_TRUSTED = 10329;
const RPS_PEER_PORT_SBOX = 10330;
const RPS_PEER_PORT_ES = 10328;
// port for the IVIS-core (or any other client-certified machine) to connect to
const RPS_PUBLIC_PORT = 10327;

const RPS_LISTEN_PORT = 10000; // ideally exposed only to localhost

// RPS_LISTEN_PORT and RJR_INTERNAL_PORT are not in this list becuase
// in the current implementation, they are bound to localhost/loopback interface
// and thus no inter-VM communication is required on the subnet
const REQUIRED_ALLOWED_PORTS = [RJR_LISTEN_PORT, RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED, RPS_PUBLIC_PORT];

{
    // check port for duplicates, since all containers are running on the host network
    // (especially important for the master peer where both the RJR and RPS applications run)
    const allPorts = [
        RJR_LISTEN_PORT, RPS_PEER_PORT_ES, RPS_PEER_PORT_SBOX, RPS_PEER_PORT_TRUSTED, RPS_PUBLIC_PORT, RJR_INTERNAL_PORT, RPS_LISTEN_PORT,
    ];
    const set = new Set();
    const conflictFound = allPorts.reduce((found, current) => {
        const result = found || set.has(current);
        set.add(current);
        return result;
    }, false);
    if (conflictFound) {
        throw new Error(`OCI Cloud Pool Config Error: port clash detected in ports: ${allPorts.join(' ')}`);
    }
}

const RJRComposeFile = `version: '3'
services:
  rjr-proxy:
    restart: always
    network_mode: "host"
    image: nginx
    volumes:
      - ./config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      # - ./cert/:/opt/cert:ro # not used here
    depends_on:
      - rjr

  rjr:
    restart: always
    network_mode: "host"
    build:
      context: ./
      dockerfile: ./Dockerfile
      network: host
    ports:
        - 127.0.0.1:${RJR_INTERNAL_PORT}:${RJR_INTERNAL_PORT}
    volumes:
      - ./data:/opt/ivis-remote/data
      - ./files:/opt/ivis-remote/files
      - ./config/default.yml:/opt/ivis-remote/config/default.yml
      # - ./cert:/opt/ivis-remote/cert # not used
`;

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
  # connects via HTTP - does not matter
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
  port: ${RJR_INTERNAL_PORT}

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
        proxy_pass http://localhost:${RJR_INTERNAL_PORT};

        proxy_set_header        Host \\$host;
        proxy_set_header        X-Real-IP \\$remote_addr;
        proxy_set_header        X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \\$scheme;
}
}
}
`;

const PATHS = {
    machineClient: 0, ca: 1, cert: 2, key: 3,
};

const PATH_DATA = {
    [PATHS.machineClient]: {
        container: '/opt/machine.pem',
        physical: './cert/machine.pem',
    },
    [PATHS.ca]: {
        container: '/opt/ca.cert',
        physical: './cert/ca.cert',
    },
    [PATHS.cert]: {
        container: '/opt/svr.pem',
        physical: './cert/svr.pem',
    },
    [PATHS.key]: {
        container: '/opt/svr.key',
        physical: './cert/svr.key',
    },
};

/**
 * @returns {{container: string, physical: string}}
 */
function path(pathType) {
    return PATH_DATA[pathType];
}

const RPSComposeFile = `version: '3'
services:
  rps-proxy:
    image: httpd:2.4.54
    network_mode: "host"
    volumes:
      - ./config/apache/apache.conf:/usr/local/apache2/conf/httpd.conf:ro
      - ./config/apache/vhosts.conf:/usr/local/apache2/conf/extra/httpd-vhosts.conf:ro
      # assumes the certificates are generated locally first
      - ${path(PATHS.machineClient).physical}:${path(PATHS.machineClient).container}:ro # simple concatenation of the ${path(PATHS.cert).container} and ${path(PATHS.key).container} files
      # here goes the local CA certificate as generated in ivis-core/certs/remote/ca folder
      - ${path(PATHS.ca).physical}:${path(PATHS.ca).container}:ro
      - ${path(PATHS.cert).physical}:${path(PATHS.cert).container}:ro
      - ${path(PATHS.key).physical}:${path(PATHS.key).container}:ro
  rps:
    restart: always
    network_mode: "host"
    build:
      context: ./
      dockerfile: ./Dockerfile
      network: host
    ports:
        - 127.0.0.1:${RPS_LISTEN_PORT}:${RPS_LISTEN_PORT} 
    volumes:
      - ./config:/opt/ivis-rps/config
`;

const getRPSConfigFile = (peerIps) => `
rps:
    port: ${RPS_LISTEN_PORT}
    peerIPs: [${peerIps.map((ip) => `'${ip}'`).join(',')}]
    peerRJRPort: ${RJR_LISTEN_PORT}
`;

function proxyTo(location, name) {
    const CAPath = config.oci.ivisSSLCertVerifiableViaRootCAs ? '/etc/ssl/certs/ca-certificates.crt' : path(PATHS.ca).container;
    return `LogLevel info ssl:warn
    ErrorLog /var/log/apache_${name}_error.log

    ProxyRequests On
    SSLProxyEngine On

    SSLProxyMachineCertificateFile ${path(PATHS.machineClient).container}
    # CA of the server we are proxying to - the expected value here is a trusted ROOT CA

    SSLProxyCACertificateFile ${CAPath}
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
        ProxyPass "http://localhost:${RPS_LISTEN_PORT}/rps"
        ProxyPassReverse "http://localhost:${RPS_LISTEN_PORT}/rps"
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

const CLONE_FOLDER_RJR = 'ivis-rjr';
const CLONE_FOLDER_RPS = 'ivis-rps';

if (CLONE_FOLDER_RJR.indexOf(CLONE_FOLDER_RPS) !== -1 || CLONE_FOLDER_RPS.indexOf(CLONE_FOLDER_RJR) !== -1) {
    throw new Error(`OCI Cloud Pool Config Error: repository folder clash: ${CLONE_FOLDER_RJR} ${CLONE_FOLDER_RPS}`);
}

function cmdInFolderGetter(repoFolder) {
    return (command) => `cd ./${repoFolder} && ${command}`;
}

function getRJRSetupCommands(masterInstancePrivateIp, instancePrivateIp) {
    const nginxConfigContents = getRJRNginxConfig(instancePrivateIp);
    const rjrConfigContents = getRJRConfigFile(masterInstancePrivateIp);
    const cmdInRepo = cmdInFolderGetter(CLONE_FOLDER_RJR);

    return [
        // allow only the master instance to connect to the docker RJR_LISTEN_PORT
        // creates a new chain restricting access for only the master instance if the port is RJR_LISTEN_PORT
        'sudo iptables -N MASTER_PEER_ACCESS',
        `sudo iptables -A MASTER_PEER_ACCESS --src ${masterInstancePrivateIp} -j ACCEPT`,
        'sudo iptables -A MASTER_PEER_ACCESS -j DROP',
        `sudo iptables -I INPUT -p tcp --dport ${RJR_LISTEN_PORT} -j MASTER_PEER_ACCESS`,
        `git clone ${config.oci.peerRJRRepo.url} ${CLONE_FOLDER_RJR}`,
        cmdInRepo((config.oci.peerRJRRepo.commit ? `git checkout ${config.oci.peerRJRRepo.commit}` : 'echo Using the master HEAD')),
        cmdInRepo(`cat > ./config/default.yml << HEREDOC_EOF\n${rjrConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./config/nginx/nginx.conf << HEREDOC_EOF\n${nginxConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./docker-compose.yml << HEREDOC_EOF\n${RJRComposeFile}\nHEREDOC_EOF`),
        cmdInRepo('sudo /usr/local/bin/docker-compose up -d --build'),
    ];
}

function getRPSSetupCommands(peerPrivateIps, masterInstancePrivateIp, masterInstancePublicIp, subnetMask, caCert, cert, key) {
    const apacheConfigContents = getRPSApacheProxyConfig(masterInstancePublicIp, masterInstancePrivateIp);
    const rpsConfigContents = getRPSConfigFile(peerPrivateIps);
    const cmdInRepo = cmdInFolderGetter(CLONE_FOLDER_RPS);

    return [
        // make PEER ports PEER-only
        // creates a new chain which allows traffic only from the cloud subnet
        'sudo iptables -N POOL_PEER_ACCESS',
        `sudo iptables -A POOL_PEER_ACCESS --src ${subnetMask} -j ACCEPT`,
        'sudo iptables -A POOL_PEER_ACCESS -j DROP',
        `sudo iptables -I INPUT -p tcp --dport ${RPS_PEER_PORT_ES} -j POOL_PEER_ACCESS`,
        `sudo iptables -I INPUT -p tcp --dport ${RPS_PEER_PORT_SBOX} -j POOL_PEER_ACCESS`,
        `sudo iptables -I INPUT -p tcp --dport ${RPS_PEER_PORT_TRUSTED} -j POOL_PEER_ACCESS`,
        `sudo iptables -I INPUT -p tcp --dport ${RPS_PUBLIC_PORT} -j ACCEPT`, // make public port public (topmost rule)
        `git clone ${config.oci.peerRPSRepo.url} ${CLONE_FOLDER_RPS}`,
        cmdInRepo((config.oci.peerRPSRepo.commit ? `git checkout ${config.oci.peerRPSRepo.commit}` : 'echo Using the master HEAD')),
        cmdInRepo('mkdir ./cert'),
        cmdInRepo(`cat > ./config/default.yml << HEREDOC_EOF\n${rpsConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./config/apache/vhosts.conf << HEREDOC_EOF\n${apacheConfigContents}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ./docker-compose.yml << HEREDOC_EOF\n${RPSComposeFile}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.ca).physical} << HEREDOC_EOF\n${caCert}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.cert).physical} << HEREDOC_EOF\n${cert}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.key).physical} << HEREDOC_EOF\n${key}\nHEREDOC_EOF`),
        cmdInRepo(`cat > ${path(PATHS.machineClient).physical} << HEREDOC_EOF\n${cert}${key}\nHEREDOC_EOF`),
        cmdInRepo('chmod +x ./setup/docker-entry.sh'),
        cmdInRepo('sudo /usr/local/bin/docker-compose up -d --build'),
    ];
}

module.exports = {
    getRJRSetupCommands, getRPSSetupCommands, RPS_PUBLIC_PORT, REQUIRED_ALLOWED_PORTS,
};
