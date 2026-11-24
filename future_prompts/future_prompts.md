# List of future prompts

## Prompt 1

___
2026|11|20 - 11:28 am

~~Please consider renaming Mesh to SimulationMesh to make sure, that it is exclusively for this repo and does not create problems beeing used in other contexts
Is there a smart way to do this without the agent has to go over each file which would end up very slow and expensive?
Also please make the examples better human readable and add way more comments to explain the steps~~
*implemented*

## Prompt 2

___
2026|11|20 - 11:01 am

~~Please have a look at the frontend of this
Create a new branch on this~~

~~The frontend should have a second tab - so do not toch the right and left panel of the current daylight, but there should be a new tab for the view analysis, only featuring the view settings and results
But it should reference of course the same usd model, also transparencies and so on
But what is blocking/receiving for the analysis should be independent in the 2 sets, because that can be sometimes different for daylight and views~~

~~in the @kit-sim_daylight_frontend/CLAUDE.md there is still a reference to the zha-ui - but that should be updated to the actual ui used, which is kitforge ui package and skill now~~
*implemented*

## Prompt 3

___
2026|11|22 - 01:18 am

~~Please have a look into the siumlation meshes please
At the moment if set on face, it always returns triangles, even if the faces are quads - please try to fix this
Also if I have disconnected parts of a same mesh, but the vertices are on the same location, that should not get the view direction from the joined edge, but should keep them seperate for the analysis
For visualization, the meshes are joined if they have common vertices and also need to be tris for visualization in three.js, but the visualization should keep the original mesh shape as the USD or glb.
Please try to change this~~

~~I also want you to do few adaptations on the UI
There should be also wa way to set a fully custom gradient and als edit the preset ones
So change the colour positions, flip the direction or choose different colours
Also there should be an option to apply a method to the visualization values, (as log or choose well fitting ones) to make smaller or large differences more clear
Also good standard gradients for the different view results~~

~~Also I want to be able to set the sun path custom around one or serverla selcted objects~~

~~I also want to have a small change on the view results: I want to be to have a result all virtual ground and obstruction joined
Please plan this accordingly~~
*implemented*

## Prompt 4

___
2026|11|22 - 14:50 pm

~~There is a problem with the materials:
The 3d view shows materials correctly, however if the simulation is run, all materials are gone after - even if only the receivers are coloured differently after
Also I would like to be able to have different display options (as the USD viewer has - so wireframe and so on)
Except the result meshes should not be influenced by that, but always shown as just pure coloured meshes~~

~~Also on "All around" ground always returns 0 - why is that? Please investigate and try to fix that
Another thing I want you to add is that the settings (in both, daylight and views) can also be set back to their default settings~~
*implemented*

## Prompt 5

___
2026|11|22 - 18:09 pm

I also want an option, that the user can save different analysis sets
So they user can set different sets of receiver/ obstruction and so on for different analytics (as for example some meshes may need facade analytics, some all around or on daylight, some may need Illuminance for interiors or radiation for calculation for solar panels)
So I want to be able to save sets of mesh settings, with simulation settings and selected results

Also concerning the UI, it can happen, that large numbers are not shown correctly in the UI - can you make sure that too large numbers get scientific notation to prevent this

Please plan this accordingly

*implemented*

## Prompt 6

___
2026|11|22 - 18:09 pm

Then please double check that the CLIs have all functionality and that the bindings for the core for all examples are well documented with examples well explained and with lot of explanatory comments
Plesae add MCP functionality for the view analysis and update the color setting, so the AI can choose colors also fitting to the targets defined by the user

## Prompt 7

___
2026|11|22 - 15:15 pm

Please add for each setting on the analysis a small diagram on the current setting, that shows diagrammatically, how the current setting is
So for views only under "field of view" and for "daylight" under "time"
Please for views also (similar to the sun path) add a visualization on the mesh directly which would preview the view fields according ot the settings - make sure that hit only shows it kind as a camera and make sure it will not compromise the performance of the viewer with many analytics parts
Also make sure, it can be same as the sun path turned on and off and also edits can be made as scaling it in scale and so on, but it should show the user the raycast field taken in account

## Prompt 8

___
2026|11|22 - 14:55 pm

Please make sure, that there is an additional tab, which can show accumulated views on meshes
That tab should always be on the right, not matter how many tabs like currently "daylight" or "view analysis" will be added
In this one I want to be able to create custom views, which either just take specific meshes from th analytics, but if meshes have several analysis, that they can also be combined (with a weighting and also functions that can be applied on the values and visualizations )
So I could for example try to apply several results on a facade surface, so evaluate a cumulative result on the "performance" of it and visualize that also accordingly
Also in this view, but also int he other result view it should be possible to sample values on the 3d mesh - so show values directly in the 3d view over the gradient (only of not covered by other meshes and also should make sure, that it is not too dense/to many values previews on each vertex if zoomed out and it should not compromise the performance of the viewer and should be toggle-able - by default off)
Please make sure, that this visualization tab and the according visualization also has full MCP access

*implemented*
