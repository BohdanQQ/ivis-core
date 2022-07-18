#!/bin/bash

# should run only once! 

DISCARD=$(
mkdir ./ca || exit
cd ./ca || exit
openssl req -x509 -nodes -keyout ca.pem -out ca.cert -newkey rsa:4096 -days 9999 -config ../localCA.cnf
)