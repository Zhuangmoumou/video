#!/bin/bash
read -s -p 'New password: ' NEW_PASS
echo
echo "加密后："
node -e 'const crypto=require("crypto"); const pw=process.argv[1]; const salt=crypto.randomBytes(16); const hash=crypto.scryptSync(pw, salt, 32);console.log(`scrypt$${salt.toString("base64")}$${hash.toString("base64")}`)' "$NEW_PASS"
