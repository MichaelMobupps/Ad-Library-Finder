#!/bin/bash
claude -c --permission-mode auto "$@" || claude --permission-mode auto "$@"
