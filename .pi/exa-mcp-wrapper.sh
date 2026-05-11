#!/bin/bash
export EXA_API_KEY=$(cat "$HOME/src/mypi/secure_data/exa_key")
exec node $HOME/src/mypi/node_modules/exa-mcp-server/smithery/stdio/index.cjs