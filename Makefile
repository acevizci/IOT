ENV ?= dev

up:
	docker compose --env-file env/.env.$(ENV) \
		-f infra/docker-compose.base.yml \
		-f infra/docker-compose.$(ENV).yml \
		up -d --build

down:
	docker compose --env-file env/.env.$(ENV) \
		-f infra/docker-compose.base.yml \
		-f infra/docker-compose.$(ENV).yml \
		down

logs:
	docker compose --env-file env/.env.$(ENV) \
		-f infra/docker-compose.base.yml \
		-f infra/docker-compose.$(ENV).yml \
		logs -f

ps:
	docker compose --env-file env/.env.$(ENV) \
		-f infra/docker-compose.base.yml \
		-f infra/docker-compose.$(ENV).yml \
		ps
