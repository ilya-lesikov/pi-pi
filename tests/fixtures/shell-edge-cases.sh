#!/bin/bash
# Fixture for shell mapper edge cases

# Normal multi-line function (should work)
greet() {
    echo "Hello, $1!"
}

# One-liner function — currently missed by shell mapper
oneliner() { echo "one line"; }

# One-liner with 'function' keyword
function another_oneliner() { return 0; }

# One-liner without parens (function keyword style)
function keyword_oneliner { echo "keyword"; }

# Normal export (single line, should work)
export SIMPLE="hello"

# Multi-line export with quoted string spanning lines
export MULTILINE="line1
line2
line3"

# Multi-line export with single quotes
export MULTI_SINGLE='first
second
third'

# Normal alias
alias shortcut='echo hi'
