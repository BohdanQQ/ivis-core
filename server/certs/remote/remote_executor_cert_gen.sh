#!/bin/bash

set -eux

# creates a multipurpose locally signed certificate intended for use in the Remote
# job executor (does not require a CNAME, sets up subject alternative names)
# usage ./remote_executor_cert_gen.sh IP OUTNAME [SubjectAlternativeName]

# OUTNAME.pem, OUTNAME.key files will be generated

EXECUTOR_IP=$1
OUT_NAME=$2
CNF_FILE=$(mktemp gen-client-cert-XXXXXXX --suffix=.cnf)

echo "
[ req ]
basicConstraints = CA:FALSE
nsCertType             = client, email, server
nsComment              = "OpenSSL Generated Server Certificate"
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer:always

[v3_req]
keyUsage               = critical, nonRepudiation, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth, clientAuth, emailProtection
subjectAltName         = @alt_names

[alt_names]
IP.1                   = ${EXECUTOR_IP}" > "${CNF_FILE}"

if [ $# -ge 3 ]; then
    EXECUTOR_NAME=$3
    echo "DNS.1=${EXECUTOR_NAME}" >> "${CNF_FILE}"
fi

KEY_NAME="${OUT_NAME}.pem"
REQ_NAME="${OUT_NAME}.csr"
CRT_NAME="${OUT_NAME}.cert"

openssl genrsa -out "${KEY_NAME}" 4096
openssl req -new -key "${KEY_NAME}" -out "${REQ_NAME}" -subj "/CN=IVIS-Executor"
openssl x509 -req -in "${REQ_NAME}" -CA ./ca/ca.cert -CAkey ./ca/ca.pem -out "${CRT_NAME}" -CAcreateserial -days 9999 -sha256 -extfile "${CNF_FILE}" -extensions v3_req

rm "${REQ_NAME}" "${CNF_FILE}"