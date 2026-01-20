#!/bin/bash

# Feedback Analyzer Setup Script
# This script creates the necessary Cloudflare resources and updates wrangler.jsonc

set -e

echo "=== Feedback Analyzer Setup ==="
echo ""

# Check if logged in to Cloudflare
echo "Checking Cloudflare authentication..."
if ! npx wrangler whoami &>/dev/null; then
    echo "Please log in to Cloudflare first:"
    npx wrangler login
fi

echo ""
echo "Creating D1 Database..."
D1_OUTPUT=$(npx wrangler d1 create feedback-db 2>&1 || true)
echo "$D1_OUTPUT"

# Extract database ID from output
D1_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2)
if [ -z "$D1_ID" ]; then
    # Try to get existing database ID
    D1_ID=$(npx wrangler d1 list 2>&1 | grep "feedback-db" | awk '{print $1}')
fi

if [ -z "$D1_ID" ]; then
    echo "Could not extract D1 database ID. Please check the output above and update wrangler.jsonc manually."
else
    echo "D1 Database ID: $D1_ID"
fi

echo ""
echo "Creating KV Namespace..."
KV_OUTPUT=$(npx wrangler kv namespace create CACHE 2>&1 || true)
echo "$KV_OUTPUT"

# Extract KV namespace ID
KV_ID=$(echo "$KV_OUTPUT" | grep -o 'id = "[^"]*"' | cut -d'"' -f2)
if [ -z "$KV_ID" ]; then
    # Try alternative pattern
    KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[a-f0-9]{32}' | head -1)
fi

if [ -z "$KV_ID" ]; then
    echo "Could not extract KV namespace ID. Please check the output above and update wrangler.jsonc manually."
else
    echo "KV Namespace ID: $KV_ID"
fi

echo ""
echo "=== Setup Summary ==="
echo "D1 Database ID: ${D1_ID:-NOT_FOUND}"
echo "KV Namespace ID: ${KV_ID:-NOT_FOUND}"
echo ""
echo "Please update your wrangler.jsonc with these IDs:"
echo ""
echo '  "d1_databases": [{'
echo '    "binding": "DB",'
echo '    "database_name": "feedback-db",'
echo "    \"database_id\": \"${D1_ID:-YOUR_D1_ID}\""
echo '  }],'
echo ""
echo '  "kv_namespaces": [{'
echo '    "binding": "CACHE",'
echo "    \"id\": \"${KV_ID:-YOUR_KV_ID}\""
echo '  }]'
echo ""
echo "Then run: npm run deploy"
