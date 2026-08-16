# Intégration Enphase IQ Gateway

Cette intégration suit en **local** votre installation solaire Enphase : production, consommation (si un compteur est présent), batterie (si une IQ Battery est installée), production individuelle de chaque **micro-onduleur**, le **IQ System Controller** et les **compteurs CT**.

## Prérequis

- Un **IQ Gateway** avec un firmware **D8+** (novembre 2023 ou plus récent).
- Le gateway joignable depuis le réseau local de votre Gladys.
- Un **jeton d'accès local** : depuis l'interface web du gateway, allez dans **Système > Accès local**, signez l'accord Enphase et copiez le jeton JWT affiché.

## Configuration

1. Installez l'intégration depuis le catalogue Gladys.
2. Renseignez l'**adresse IP locale** du gateway (ou utilisez le bouton **« Détecter le gateway »** qui le trouve par mDNS).
3. Collez votre **jeton d'accès local**.
4. Choisissez l'**intervalle de rafraîchissement** (15 à 600 secondes, 60 par défaut).
5. Cochez **« Suivre chaque micro-onduleur »** pour obtenir un appareil par onduleur.

L'intégration ne fait **aucun appel cloud** : tout reste sur votre réseau local.

## Appareils publiés

Les valeurs sont publiées en **kW / kWh** (puissance / énergie), **%** (niveau de batterie), **°C** (température), **V** (tension) et **A** (courant), arrondies à **3 décimales maximum**.

- **Un appareil « gateway »** : production (kW), production du jour, des 7 derniers jours et cumulée (kWh), consommation (kW et kWh/jour) si un compteur existe, et batterie (niveau %, puissance de charge/décharge, énergie restante) si une IQ Battery est installée.
- **Un appareil par micro-onduleur** (si activé) : puissance instantanée (kW) et statut texte (« Actif », « Hors-ligne… ») pour repérer un onduleur défaillant.
- **Un appareil par IQ Battery (Encharge)** : niveau (%), température (°C), puissance (kW) et capacité (kWh).
- **Un appareil « IQ System Controller » (Enpower)** : mode réseau, température (°C) et état admin.
- **Un appareil par compteur CT** : puissance active (kW), énergie délivrée / reçue (kWh), tension (V) et courant (A).

Les appareils Encharge, Enpower et compteurs CT ne sont publiés que si le gateway les rapporte (détection automatique).

## Sécurité : épingler le certificat du gateway

Le gateway utilise un **certificat auto-signé** : l'intégration ne peut donc pas en vérifier cryptographiquement l'identité par défaut. Un appareil malveillant présent sur votre réseau local pourrait en théorie se faire passer pour le gateway et récupérer votre jeton d'accès.

**Recommandé :** renseignez le champ **« Empreinte du certificat du gateway (optionnel) »**. L'intégration ne fait alors confiance qu'à un gateway qui présente exactement ce certificat — un imposteur est rejeté (`CERT_PIN_MISMATCH`) même si la validation TLS reste allégée.

1. Depuis une machine de confiance sur le même réseau, lisez l'empreinte du vrai gateway :
   ```
   openssl s_client -connect <adresse_gateway>:443 \
     < /dev/null 2>/dev/null | \
     openssl x509 -noout -fingerprint -sha256
   ```
2. Copiez la valeur `SHA256 Fingerprint=...` dans le champ **Empreinte du certificat du gateway**.
3. Enregistrez — l'empreinte est appliquée immédiatement. La casse et les séparateurs ne comptent pas (le code les normalise).

Si le certificat du gateway change un jour (mise à jour du firmware, remplacement du boîtier), l'intégration refusera de se connecter : relisez la nouvelle empreinte et mettez à jour le champ.

À noter : l'empreinte protège toutes les connexions effectuées après sa configuration. Lisez toujours l'empreinte depuis votre propre gateway de confiance, jamais via une source intermédiaire.

## Dépannage

- **« Jeton refusé »** : le jeton est invalide, expiré ou révoqué. Régénérez-le dans le menu du gateway (Système > Accès local).
- **« Gateway injoignable »** : vérifiez que le gateway est allumé, sur le même réseau, et que l'IP est correcte (le bouton « Détecter le gateway » la retrouve par mDNS).
- **« Détecter le gateway » ne trouve rien** : le gateway publie plusieurs adresses en mDNS, dont des adresses IPv6. L'intégration ne retient qu'une adresse privée (IPv4 en priorité) et n'envoie jamais le jeton vers une adresse publique — si aucune adresse privée n'est publiée, renseignez l'IP LAN du gateway manuellement.
- **Aucune consommation affichée** : votre installation n'a pas de compteur de consommation branché — l'intégration ne publie les données que si le gateway les rapporte.
- **« Empreinte du certificat refusée »** : le certificat du gateway a changé ou un appareil tente de l'usurper. Relisez l'empreinte réelle et mettez à jour le champ.
- Le badge de transport reste **local** quand tout va bien, et passe à **injoignable** quand le gateway ne répond plus.
