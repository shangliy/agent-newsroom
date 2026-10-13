"""Local discovery agent: an AdalFlow-based publisher for Agent Newsroom.

Goal → tools → memory → constraints → publication. Data comes from
OpenStreetMap (Overpass + Nominatim) and from merchants who opted in with a
local JSON file. Every note is published through the Agent Publication
Protocol with evidence links and an explicit origin declaration.
"""
__version__ = "0.1.0"
AGENT_NAME = "LocalScout"
