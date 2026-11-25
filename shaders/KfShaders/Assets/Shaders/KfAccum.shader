// Quality stills: many renders added together (each weighted 1 / count) into a float picture.
Shader "Hidden/KeyframeStudio/Accum"
{
    Properties
    {
        _MainTex ("", 2D) = "white" {}
    }
    SubShader
    {
        ZTest Always Cull Off ZWrite Off
        Blend One One
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "KfCommon.cginc"

            float _KfWeight;

            float4 frag(v2f i) : SV_Target
            {
                return tex2D(_MainTex, i.uv) * _KfWeight;
            }
            ENDCG
        }
    }
    Fallback Off
}
