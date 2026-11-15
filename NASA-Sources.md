# NASA Mars, Planetary Data, and Human Spaceflight Sources

A categorized reference list of NASA data portals, APIs, instrument
archives, and technical standards.

## 1. Live NASA Web APIs and Tile Endpoints

  ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  Source                  Purpose / Use           Links
  ----------------------- ----------------------- ---------------------------------------------------------------------------------------------------------------------------
  **NASA JPL Mars Trek**  Mars mapping portal and [Mars Trek Portal](https://trek.nasa.gov/mars/) · [API Documentation](https://trek.nasa.gov/mars/apidoc/trekAPI.html)
                          API documentation       

  **Mars Trek --- Mount   Live WMTS tile endpoint [Open
  Sharp tile**            used in the app (`z=4`) tile](https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/4/8/14.jpg)

  **Mars Trek --- Jezero  Live WMTS tile endpoint [Open
  Delta tile**            used in the app (`z=4`) tile](https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/4/6/11.jpg)

  **NASA CCMC DONKI ---   Space Weather Database  [DONKI Portal](https://ccmc.gsfc.nasa.gov/tools/DONKI/) · [NASA API Documentation](https://api.nasa.gov/) · [Live SEP JSON
  SEP API**               of Notifications,       endpoint](https://api.nasa.gov/DONKI/SEP?api_key=DEMO_KEY)
                          Knowledge, Information; 
                          Solar Energetic         
                          Particle events         
  ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

## 2. NASA Planetary Data System (PDS) Instrument Archives

### Layer 1 --- Terrain and Elevation

  ---------------------------------------------------------------------------------------------------------------------
  Dataset / Instrument    Data                    Archive
  ----------------------- ----------------------- ---------------------------------------------------------------------
  **MRO HiRISE DTM        High-resolution digital [HiRISE DTM Archive](https://www.uahirise.org/dtm/) · [PDS
  (DTEEC)**               terrain models          Geosciences ---
                                                  HiRISE](https://pds-geosciences.wustl.edu/missions/mro/hirise.htm)

  **MGS MOLA MEGDR**      Global Mars elevation   [MOLA MEGDR
                          data                    Archive](https://pds-geosciences.wustl.edu/missions/mgs/megdr.html)
  ---------------------------------------------------------------------------------------------------------------------

### Layer 2 --- Thermal Properties

  --------------------------------------------------------------------------------------------------------------------------
  Dataset / Instrument    Data                    Archive
  ----------------------- ----------------------- --------------------------------------------------------------------------
  **2001 Mars Odyssey     Thermal inertia data    [PDS THEMIS
  THEMIS (TIU)**                                  Archive](https://pds-geosciences.wustl.edu/missions/odyssey/themis.html) ·
                                                  [ASU THEMIS Data Portal](https://themis.asu.edu/)

  --------------------------------------------------------------------------------------------------------------------------

### Layer 3 --- Mineralogy and Hydrated Materials

  --------------------------------------------------------------------------------------------------------------------
  Dataset / Instrument    Data                    Archive
  ----------------------- ----------------------- --------------------------------------------------------------------
  **MRO CRISM**           Spectral summary        [PDS CRISM
                          products, including     Archive](https://pds-geosciences.wustl.edu/missions/mro/crism.htm)
                          hydrated sulfates and   
                          phyllosilicates         

  --------------------------------------------------------------------------------------------------------------------

### Layer 4 --- Surface Weather and Wind

  ----------------------------------------------------------------------------------------------------------------------------------------------
  Dataset / Instrument    Data                    Archive
  ----------------------- ----------------------- ----------------------------------------------------------------------------------------------
  **Curiosity REMS**      Rover Environmental     [PDS Atmospheres --- REMS
                          Monitoring Station      Archive](https://atmos.nmsu.edu/data_and_services/atmospheres_data/MARS/curiosity/rems.html)
                          observations            

  **Perseverance MEDA**   Mars Environmental      [PDS Atmospheres --- MEDA
                          Dynamics Analyzer       Archive](https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/)
                          observations, including 
                          surface wind            
  ----------------------------------------------------------------------------------------------------------------------------------------------

### Layer 5 --- Radiation

  ----------------------------------------------------------------------------------------------------------------------------------
  Dataset / Instrument    Data                    Archive
  ----------------------- ----------------------- ----------------------------------------------------------------------------------
  **Curiosity RAD**       Radiation Assessment    [PDS PPI --- MSL RAD
                          Detector surface-dose   Archive](https://pds-ppi.igpp.ucla.edu/search/?sc=Mars_Science_Laboratory&i=RAD)
                          data                    

  ----------------------------------------------------------------------------------------------------------------------------------

### Supporting Geometry Data

  -------------------------------------------------------------------------------------------------
  Source                  Purpose                 Link
  ----------------------- ----------------------- -------------------------------------------------
  **NASA NAIF SPICE**     Solar ephemeris and     [NAIF PDS Node ---
                          illumination geometry   Data](https://naif.jpl.nasa.gov/naif/data.html)
                          data                    

  -------------------------------------------------------------------------------------------------

## 3. NASA Human Spaceflight and Bioenergetics Standards

  -------------------------------------------------------------------------------------------------------------------------
  Source / Publication    Relevance               Link
  ----------------------- ----------------------- -------------------------------------------------------------------------
  **NASA-STD-3001, Volume NASA spaceflight        [Official NASA
  1**                     human-system standard;  Standard](https://standards.nasa.gov/standard/nasa/nasa-std-3001-vol-1)
                          crew health             

  **NASA-STD-3001, Volume NASA spaceflight        [Official NASA
  2**                     human-system standard;  Standard](https://standards.nasa.gov/standard/nasa/nasa-std-3001-vol-2)
                          habitability and        
                          human-system            
                          integration             

  **Biomedical Results of Historical biomedical   [NASA NTRS Record](https://ntrs.nasa.gov/citations/19760005580)
  Apollo (NASA SP-368)**  research, including EVA 
                          metabolic and           
                          oxygen-consumption data 

  **Partial-Gravity EVA   Research on energy      [NASA Technical Reports Server](https://ntrs.nasa.gov/)
  Locomotion Energetics   expenditure and         
  (Santee et al., 2001)** locomotion during       
                          extravehicular activity 
                          in partial gravity      
  -------------------------------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## Notes

-   The Mars Trek tile URLs are specific live tile endpoints used by the
    application; the zoom level is `z=4`.
-   The DONKI SEP endpoint uses NASA's `DEMO_KEY`, which is intended for
    limited demonstration use and may have request limits. For sustained
    use, consult the [NASA API portal](https://api.nasa.gov/) for an API
    key.
-   PDS archive pages provide access to mission datasets and associated
    documentation. Check each archive for product-specific formats,
    coverage, and usage guidance.
