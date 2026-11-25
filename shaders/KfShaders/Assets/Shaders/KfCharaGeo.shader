// Character lights, step 1 (a replacement shader on a camera that sees characters only): each pixel's surface
// direction (world) and its distance from the camera. Not cut by texture alpha (the game's baked skin and clothes
// textures don't keep coverage there): the light step checks this distance against the view's own depth instead.
Shader "Hidden/KeyframeStudio/CharaGeo"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
        _Cutoff ("", Float) = 0.1
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float4 _MainTex_ST;

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 n : TEXCOORD1;
                float depth : TEXCOORD2;
            };

            v2f vert(appdata_base v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.texcoord, _MainTex);
                o.n = UnityObjectToWorldNormal(v.normal);
                o.depth = -UnityObjectToViewPos(v.vertex).z;
                return o;
            }

            float4 frag(v2f i, fixed facing : VFACE) : SV_Target
            {
                float3 n = normalize(i.n) * (facing > 0 ? 1 : -1); // back faces (two-sided cloth) face the camera too
                return float4(n, i.depth);
            }
            ENDCG
        }
    }
    Fallback Off
}
