#!/usr/bin/env node
const process = require('process')
const serve = require('./')

serve(process.argv[2] || '/run/agent.sock')
