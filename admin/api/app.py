import logging
import psycopg2
import os

from asgi_tools import App, ResponseError
from datetime import datetime, timezone
from logging import Formatter, FileHandler
from utils import execute_query
from schema import Schema, And, Or, Use, Optional, SchemaError

from babylon import Babylon

logger = logging.getLogger('babylon-admin-api')

CREATE_INCIDENTS_TABLE = """CREATE TABLE IF NOT EXISTS incidents (
                        id SERIAL PRIMARY KEY, 
                        status varchar(50) NOT NULL,
                        incident_type varchar(50),
                        level varchar(50),
                        message TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT check_status CHECK (status IN ('active', 'resolved')), 
                        CONSTRAINT check_level CHECK (level IN ('critical', 'info', 'warning')), 
                        CONSTRAINT check_incident_type CHECK (incident_type IN ('general'))
                    );"""
INSERT_INCIDENT = (
    """INSERT INTO incidents (incident_type, status, level, message, updated_at, created_at) 
    VALUES (%(incident_type)s, %(status)s, %(level)s, %(message)s, NOW(), NOW());"""
)
UPDATE_INCIDENT = (
    """UPDATE incidents SET 
        status = %(status)s, 
        incident_type = %(incident_type)s,
        level = %(level)s,
        message = %(message)s, 
        updated_at = NOW() 
    WHERE id = %(incident_id)s;"""
)
GET_INCIDENTS_BY_STATUS = (
    """SELECT * FROM incidents WHERE status = %(status)s;"""
)

app = App()

@app.on_startup
async def on_startup():
    await Babylon.on_startup()
    await execute_query(CREATE_INCIDENTS_TABLE)

@app.on_shutdown
async def on_cleanup():
    await Babylon.on_cleanup()

@app.route("/", methods=['GET'])
async def index(request):
    return 200, '<h1>Babylon Admin API</h1>'

@app.route("/api/admin/v1/incidents", methods=['GET'])
async def incidents_get(request):
    status = request.query.get("status", 'active')
    query = await execute_query(GET_INCIDENTS_BY_STATUS, {
                'status': status,
            })
    return query.get("result", [])

@app.route("/api/admin/v1/incidents", methods=['POST'])
async def create_incident(request):
    schema = Schema({
        "incident_type": And(str, len, lambda s: s in ('general')),
        "status": And(str, len, lambda s: s in ('active', 'resolved')),
        "level": And(str, len, lambda s: s in ('critical', 'info', 'warning')),
        "message": And(str, len)
    })
    data = await request.data()
    try:
        schema.validate(data)
    except Exception as e:
        logger.info(f"Invalid incident params - {e}")
        return 400, 'Invalid parameters'
    status = data["status"]
    incident_type = data["incident_type"]
    level = data["level"]
    message = data["message"]
    logger.info(f"New incident {status} - {incident_type} - {message}")
    try: 
        await execute_query(INSERT_INCIDENT, {
            'incident_type': incident_type,
            'status': status,
            'level': level,
            'message': message
        })
    except:
        return 400, 'Invalid parameters'
    return 200, 'Incident created.'

@app.route("/api/admin/v1/incidents/{incident_id}", methods=['POST'])
async def update_incident(request):
    schema = Schema({
        "incident_type": And(str, len, lambda s: s in ('general')),
        "status": And(str, len, lambda s: s in ('active', 'resolved')),
        "level": And(str, len, lambda s: s in ('critical', 'info', 'warning')),
        "message": And(str, len)
    })
    data = await request.data()
    try:
        schema.validate(data)
    except Exception as e:
        logger.info(f"Invalid incident params - {e}")
        return 400, 'Invalid parameters'
    incident_id = request.path_params.get("incident_id")
    status = data["status"]
    incident_type = data["incident_type"]
    level = data["level"]
    message = data["message"]
    logger.info(f"Update incident {incident_id} - {status} - {incident_type} - {message}")
    try: 
        await execute_query(UPDATE_INCIDENT, {
            'status': status,
            'incident_type': incident_type,
            'level': level,
            'message': message,
            'incident_id': incident_id
        })
    except:
        return 400, 'Invalid parameters'
    return 200, 'Incident updated.'