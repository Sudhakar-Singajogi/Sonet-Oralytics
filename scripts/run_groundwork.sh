#!/usr/bin/env bash
set -euo pipefail
node tools/pipelineGroundwork.js --raw data/raw --processed data/processed --chunks data/chunks --config configs/default.yaml
