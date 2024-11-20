default: help
release: ## Tag a new version
	cp README.md ./gatsby-plugin-s3/README.md
	cd ./gatsby-plugin-s3 && npm install && npm run build && npm publish --access public
	cd ..
help: ## Display a list of commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
