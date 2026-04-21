#!/bin/bash
# Sample shell script for readmap mapper testing

export APP_NAME="myapp"
export VERSION="1.0.0"

alias ll='ls -la'
alias gs='git status'

function deploy() {
    echo "Deploying $APP_NAME v$VERSION"
    docker build -t "$APP_NAME:$VERSION" .
    docker push "$APP_NAME:$VERSION"
}

build_image() {
    local tag="${1:-latest}"
    echo "Building image with tag: $tag"
    docker build -t "$APP_NAME:$tag" .
}

function cleanup {
    echo "Cleaning up..."
    rm -rf /tmp/build-*
    docker system prune -f
}

# A function with a heredoc inside
function generate_config() {
    cat <<EOF
server:
  host: localhost
  port: 8080
  name: $APP_NAME
EOF
}

run_tests() {
    echo "Running tests..."
    npm test
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo "Tests failed!"
        return 1
    fi
    echo "Tests passed!"
}

export PATH="/usr/local/bin:$PATH"
