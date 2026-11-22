# List of future prompts


## Prompt 1

___
2026|11|20 - 11:28 am

Please consider renaming Mesh to SimulationMesh to make sure, that it is exclusively for this repo and does not create problems beeing used in other contexts
Is there a smart way to do this without the agent has to go over each file which would end up very slow and expensive?
Also please make the examples better human readable and add way more comments to explain the steps
*implemented*

## Prompt 2

___
2026|11|20 - 11:01 am

Please have a look at the frontend of this
Create a new branch on this

The frontend should have a second tab - so do not toch the right and left panel of the current daylight, but there should be a new tab for the view analysis, only featuring the view settings and results
But it should reference of course the same usd model, also transparencies and so on
But what is blocking/receiving for the analysis should be independent in the 2 sets, because that can be sometimes different for daylight and views

in the @kit-sim_daylight_frontend/CLAUDE.md there is still a reference to the zha-ui - but that should be updated to the actual ui used, which is kitforge ui package and skill now
*implemented*

## Prompt 3

___
2026|11|22 - 01:18 am

Please have a look into the siumlation meshes please
At the moment if set on face, it always returns triangles, even if the faces are quads - please try to fix this
Also if I have disconnected parts of a same mesh, but the vertices are on the same location, that shoud not get the view direction from the joined edge, but should keep them seperate for the analysis
For visualization, the meshes are joined if they have common vertices and also need to be tris for visualization in three.js, but the visualization should keep the original mesh shape as the USD or glb 
Please try to change this

I also want you to do few adaptations on the UI
There should be also wa way to set a fully custom gradient and als edit the preset ones
So change the colour posisons, flip the direction or choose different colours
Also there should be an option to apply a method to the visualization values, (as log or choose well fitting ones) to make smaller or large differences more clear
Also good standard gradients for the different view results

Also I want to be able to set the sun path custom around one or serverla selcted objects

I also want to have a small change on the view results: I want to be to have a result all virutal ground and obstruction joined
Please plan this accordingly
*implemented*

## Prompt 4

___
2026|11|22 - 14:50 pm

Please double check that the CLIs have all funcitonality and that the bindings for the core for all examples are well documented with examples well explained and with lot of explanatory comments
Plesae add MCP functionality for the view analysis and update the colour setting, so the AI can choose colours also fitting to the targets defined by the user

## Prompt 5

___
2026|11|22 - 14:55 pm

Please make sure, that there is an additional tab, which can show accumlated views on meshes
That tab should always be on the right, not matter how many tabs like currently "daylight" or "view analysis" will be added
In this one I want to be able to create custom views, which either just take specific meshes from teh analytics, but if meshes have several anaysis, that they can also be combined (with a weigting and also functions that can be applied on the values and visulisations)
So I could for example try to apply several results on a facade surface, so evaluate a cumulative result on the "performance" of it and visulize that also accordingly
Please mke sure, that this visualization tab and the according visualization also has full MCP access
