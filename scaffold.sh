#!/bin/bash

set -e

if [ -z "$COMPOSIO_API_KEY" ]; then
	echo "Error: COMPOSIO_API_KEY is not set" >&2
	exit 1
fi

echo "Fetching OpenRouter API key..."
OPENROUTER_RESPONSE=$(curl -s -X POST "https://product-eng.hiring.composio.io/api/openrouter-key?mini-rube=true" -H "x-composio-api-key: $COMPOSIO_API_KEY")

if command -v jq >/dev/null 2>&1; then
	OPENROUTER_API_KEY=$(echo "$OPENROUTER_RESPONSE" | jq -r '.apiKey')
else
	OPENROUTER_API_KEY=$(echo "$OPENROUTER_RESPONSE" | grep -o '"apiKey":"[^"]*' | cut -d'"' -f4)
fi

if [ -z "$OPENROUTER_API_KEY" ] || [ "$OPENROUTER_API_KEY" = "null" ]; then
	echo "Error: Failed to get openrouter api key" >&2
	echo "Response: $OPENROUTER_RESPONSE" >&2
	exit 1
fi

echo "Creating auth configs..."

# Use bun to run scaffold logic
bun -e "
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

const googleSuperAuthConfig = await composio.authConfigs.create('googlesuper', {
  name: 'Mini Rube Auth Config',
  type: 'use_composio_managed_auth',
});

const githubAuthConfig = await composio.authConfigs.create('github', {
  name: 'Mini Rube GitHub Auth Config',
  type: 'use_composio_managed_auth',
});

const envContent = \`COMPOSIO_API_KEY=\${process.env.COMPOSIO_API_KEY}
GOOGLESUPER_AUTH_CONFIG_ID=\${googleSuperAuthConfig.id}
GITHUB_AUTH_CONFIG_ID=\${githubAuthConfig.id}
OPENROUTER_API_KEY=$OPENROUTER_API_KEY\`;

await Bun.write('.env', envContent);
console.log('env file created');
console.log('  googlesuper auth config:', googleSuperAuthConfig.id);
console.log('  github auth config:', githubAuthConfig.id);
"

echo ""
echo "Done! Run: bun --hot src/server.ts"
