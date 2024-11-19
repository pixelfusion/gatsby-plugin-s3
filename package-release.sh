#!/bin/bash

# Check if a version parameter is provided
if [ $# -eq 0 ]; then
  echo "Error: Version parameter is missing."
  exit 1
fi

# Store the version parameter
version=$1

# Update package.json with the provided version
jq --arg version "$version" '.version = $version' gatsby-plugin-s3/package.json > gatsby-plugin-s3/package-temp.json
mv gatsby-plugin-s3/package-temp.json gatsby-plugin-s3/package.json

# Commit the package.json changes
git add gatsby-plugin-s3/package.json
git commit -m "chore: update package.json version to $version"

# Push the changes to origin
git push origin

echo "Package version updated successfully to $version and changes pushed to origin."
