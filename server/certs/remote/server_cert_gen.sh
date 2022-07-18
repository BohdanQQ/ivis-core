#!/bin/bash

set -eux

# creates multi-purpose (server & client) locally-signed certificate for this IVIS-core instance
# usage: server_cert_gen.sh OUTNAME IVISNAME SBOXNAME APINAME 
# if you would like to use this certificate as the referse proxy server cert, edit your /etc/hosts or 
#corresponding Windows hosts file to have your CNAME point to localhost

# OUTNAME.pem, OUTNAME.key files will be generated

OUT_NAME=$1
IVIS_NAME=$2
SBOX_NAME=$3
API_NAME=$4
CNF_FILE=$(mktemp gen-server-cert-XXXXXXX --suffix=.cnf)

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
DNS.1                  = ${IVIS_NAME}
DNS.2                  = ${SBOX_NAME}
DNS.3                  = ${API_NAME}
" > "${CNF_FILE}"

KEY_NAME="${OUT_NAME}.pem"
REQ_NAME="${OUT_NAME}.csr"
CRT_NAME="${OUT_NAME}.cert"

openssl genrsa -out "${KEY_NAME}" 4096
openssl req -new -key "${KEY_NAME}" -out "${REQ_NAME}" -subj "/CN=${IVIS_NAME}"
openssl x509 -req -in "${REQ_NAME}" -CA ./ca/ca.pem -CAkey ./ca/ca.key -out "${CRT_NAME}" -CAcreateserial -days 9999 -sha256 -extfile "${CNF_FILE}" -extensions v3_req

rm "${REQ_NAME}" "${CNF_FILE}"