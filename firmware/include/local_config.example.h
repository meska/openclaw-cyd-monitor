#pragma once

// Copia questo file come local_config.h per incorporare un endpoint LAN nell'immagine OTA.
// local_config.h e' ignorato da Git, cosi indirizzi privati e configurazioni locali no va in giro.
#define OPENCLAW_BRIDGE_URL "http://192.168.1.20:8765"
