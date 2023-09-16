#!/bin/sh

set -e

pnpm run build

cd ../dist

npm publish --access public
cd -

echo "Publish completed"
